// PlayerGuard: liveness probing for a D-Bus single-instance application.
//
// GNOME Showtime ("视频播放器") can deadlock while starting playback
// (upstream GNOME/showtime#309 and #299): the main loop blocks on a
// GStreamer lock that a streaming thread only releases after the main loop
// runs again. The frozen process keeps owning org.gnome.Showtime, so the
// next launch is handed to it by D-Bus activation and silently does nothing
// — the player looks broken until that process is gone.
//
// "Owns the name" is therefore not enough to call the app alive:
// org.freedesktop.DBus.Peer.Ping is answered from the main loop, so a
// timeout means the process is wedged and must be killed to free the name.
//
// This module is shell-independent on purpose: it is imported by the
// playerfix feature and can be exercised standalone through `gjs -m`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';
const PEER_IFACE = 'org.freedesktop.DBus.Peer';
const PEER_PATH = '/';

// Probe results handed to the feature.
// absent  - nobody owns the bus name (the app is not running)
// healthy - the owner answers Peer.Ping from its main loop
// hung    - the owner swallowed the ping: wedged, name needs freeing
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
     * @param {number} timeoutMs how long the ping may take before the owner
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
            await this._call(this._busName, PEER_PATH, PEER_IFACE, 'Ping',
                null, timeoutMs);
            return {state: ProbeState.HEALTHY, owner, pid};
        } catch (e) {
            if (this._isTimeout(e))
                return {state: ProbeState.HUNG, owner, pid};

            // The name may have been released while the ping was in flight.
            if (!(await this.owner()))
                return {state: ProbeState.ABSENT};

            this._log?.debug(`gnome-toolbox: player ping failed: ${e.message}`);
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

    _call(busName, objectPath, iface, method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(busName, objectPath, iface, method, params,
                null, Gio.DBusCallFlags.NONE, timeoutMs, null,
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
