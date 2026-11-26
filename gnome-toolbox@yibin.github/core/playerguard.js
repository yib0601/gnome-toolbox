// PlayerGuard: liveness probing for a D-Bus single-instance application.
//
// GNOME Showtime ("视频播放器") can deadlock while starting playback
// (upstream GNOME/showtime#309 and #299): the main loop blocks on a
// GStreamer lock that a streaming thread only releases after the main loop
// runs again. The frozen process keeps owning org.gnome.Showtime, so the
// next launch is handed to it by D-Bus activation and silently does nothing
// — the player looks broken until that process is gone.
//
// "Owns the name" is therefore not enough to call the app alive: the owner has
// to answer on its main loop. Peer methods are not usable here — GDBus answers
// org.freedesktop.DBus.Peer.* (Ping, GetMachineId) for a connection from the
// calling thread of the message bus, so a wedged app still pings OK. The probe
// pins LIVENESS below to a specific path/interface/method pair.
//
// This module is shell-independent on purpose: it is imported by the
// playerfix feature and exercised by scripts/test-playerguard.sh.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';

// Liveness probe: a reply proves the main loop still dispatches, a timeout
// proves it does not, and UnknownMethod / UnknownObject / UnknownInterface mean
// the loop answered too. Pin this to a method the app itself implements on a
// real object path, or the signal stops meaning anything.
const LIVENESS = Object.freeze({
    interface: 'org.freedesktop.DBus.Peer',
    method: 'Ping',
    path: '/',
    params: null,
});

// Probe results handed to the feature.
// absent  - nobody owns the bus name (the app is not running)
// healthy - the owner answered LIVENESS on its main loop
// hung    - the owner swallowed it: wedged, name needs freeing
// unknown - the ping failed for a reason other than a timeout
export const ProbeState = Object.freeze({
    ABSENT: 'absent',
    HEALTHY: 'healthy',
    HUNG: 'hung',
    UNKNOWN: 'unknown',
});

function delay(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

export class PlayerGuard {
    /**
     * @param {string} busName well-known name of the single-instance app
     * @param {Object|null} log logger exposing debug/warn, e.g. core/logger
     */
    constructor(busName, log = null) {
        this._busName = busName;
        this._log = log;
        this._watchId = 0;
    }

    get busName() {
        return this._busName;
    }

    /**
     * Watch the app's bus name without polling the bus.
     * @param {Function} onAppear called when the app takes the name
     * @param {Function} onVanish called when the name is released
     */
    watch(onAppear, onVanish) {
        this.unwatch();
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, this._busName, Gio.BusNameWatcherFlags.NONE,
            () => onAppear(), () => onVanish());
    }

    unwatch() {
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
    }

    /**
     * Current unique name of the app, or null when it is not running.
     * @returns {Promise<string|null>}
     */
    async owner() {
        try {
            const reply = await this._call(DBUS_NAME, DBUS_PATH, DBUS_IFACE,
                'GetNameOwner', new GLib.Variant('(s)', [this._busName]), 1000);
            return reply.deepUnpack()[0];
        } catch (e) {
            // NameHasNoOwner is the normal "not running" answer.
            return null;
        }
    }

    /**
     * @param {number} timeoutMs how long the probe may take before the owner
     *   is considered wedged
     * @returns {Promise<{state: string, owner?: string, pid?: number,
     *   error?: string}>}
     */
    async probe(timeoutMs = 3000) {
        const owner = await this.owner();
        if (!owner)
            return {state: ProbeState.ABSENT};

        const pid = await this._pidFor(owner);

        try {
            await this._call(owner, LIVENESS.path, LIVENESS.interface,
                LIVENESS.method, LIVENESS.params, timeoutMs);
            return {state: ProbeState.HEALTHY, owner, pid};
        } catch (e) {
            if (this._isTimeout(e))
                return {state: ProbeState.HUNG, owner, pid};
            if (this._isAnswered(e))
                return {state: ProbeState.HEALTHY, owner, pid};

            // The name may have been released while the probe was in flight.
            if (!(await this.owner()))
                return {state: ProbeState.ABSENT};

            this._log?.debug(`gnome-toolbox: player probe failed: ${e.message}`);
            return {state: ProbeState.UNKNOWN, owner, pid, error: e.message};
        }
    }

    /**
     * Terminate a wedged process and wait for its bus name to be released.
     * SIGTERM first (its default action works even when the main loop is
     * blocked); SIGKILL only when the name survives the grace period.
     * @param {number|null} pid
     * @param {number} graceMs
     * @returns {Promise<boolean>} true when the bus name is free again
     */
    async kill(pid, graceMs = 1200) {
        if (!pid)
            return false;

        this._signal('TERM', pid);
        await delay(graceMs);

        if (await this.owner()) {
            this._log?.warn(`gnome-toolbox: player ${pid} ignored SIGTERM, killing`);
            this._signal('KILL', pid);
            await delay(400);
        }

        return (await this.owner()) === null;
    }

    async _pidFor(owner) {
        try {
            const reply = await this._call(DBUS_NAME, DBUS_PATH, DBUS_IFACE,
                'GetConnectionUnixProcessID', new GLib.Variant('(s)', [owner]), 1000);
            return reply.deepUnpack()[0];
        } catch (e) {
            this._log?.debug(`gnome-toolbox: player pid lookup failed: ${e.message}`);
            return null;
        }
    }

    _signal(signal, pid) {
        // pid comes from D-Bus as a uint32, so no quoting is involved.
        try {
            GLib.spawn_command_line_async(`kill -${signal} ${pid}`);
        } catch (e) {
            this._log?.warn(`gnome-toolbox: kill -${signal} ${pid} failed: ${e.message}`);
        }
    }

    _isTimeout(error) {
        return error instanceof GLib.Error &&
            error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.TIMED_OUT);
    }

    // The owner answered the message, it just does not implement the probe
    // method — that still proves its main loop is running.
    _isAnswered(error) {
        if (!(error instanceof Gio.DBusError))
            return false;
        return error.matches(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD) ||
            error.matches(Gio.DBusError, Gio.DBusError.UNKNOWN_OBJECT) ||
            error.matches(Gio.DBusError, Gio.DBusError.UNKNOWN_INTERFACE);
    }

    _call(busName, objectPath, iface, method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            // NO_AUTO_START: a probe must never spawn the thing it probes.
            Gio.DBus.session.call(busName, objectPath, iface, method, params,
                null, Gio.DBusCallFlags.NO_AUTO_START, timeoutMs, null,
                (connection, res) => {
                    try {
                        resolve(connection.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
}
