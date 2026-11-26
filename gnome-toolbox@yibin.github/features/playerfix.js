// Video player unstick: GNOME Showtime ("视频播放器") can deadlock at startup
// while owning org.gnome.Showtime, which makes every later launch vanish into
// the frozen singleton ("点图标没反应"). This feature pings the owner from the
// shell, reports the state in the toolbox menu and kills the wedged process so
// the next launch starts fresh.
//
// Probe/kill logic lives in core/playerguard.js (shell-independent, covered by
// scripts/test-playerguard.sh); this file is only the UI, timers and settings.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {PanelFeature} from '../core/feature.js';
import {Logger} from '../core/logger.js';
import {PlayerGuard, ProbeState} from '../core/playerguard.js';

// One entry per guarded app; adding another player means adding a row here.
// Only apps that (a) busy-name themselves as a D-Bus singleton and (b) answer
// the LIVENESS probe in core/playerguard.js from their main loop qualify.
const GUARDED_PLAYERS = [
    {busName: 'org.gnome.Showtime', label: '视频播放器'},
];

const PING_TIMEOUT_MS = 3000;
// Consecutive unanswered probes before the automatic path kills the process.
// A wedged process fails every probe; a merely busy one recovers in between.
const AUTO_STRIKES = 3;
// Let a freshly appeared app finish preroll before the first probe.
const FIRST_PROBE_DELAY_S = 3;

const OSD_ICON = new Gio.ThemedIcon({name: 'media-playback-start-symbolic'});

const STATE_TEXT = {
    unknown: '—',
    probing: '检查中…',
    healthy: '正常',
    hung: '无响应',
    absent: '未运行',
};

export class PlayerFixFeature extends PanelFeature {
    constructor(ctx) {
        super(ctx);
        this._guard = new PlayerGuard(GUARDED_PLAYERS[0].busName, Logger);
        this._label = GUARDED_PLAYERS[0].label;
        this._row = null;
        this._statusLabel = null;
        this._timerId = 0;
        this._menuId = 0;
        this._settingsId = 0;
        this._strikes = 0;
        this._present = false;
        this._busy = false;
        this._state = ProbeState.UNKNOWN;
    }

    get id() {
        return 'playerfix';
    }

    get settingsKey() {
        return 'enable-player-fix';
    }

    // Menu-only feature: the state readout doubles as the "fix now" action.
    panelActors() {
        return [];
    }

    buildMenu(menu) {
        this._row = new PopupMenu.PopupMenuItem('', {});
        const box = new St.BoxLayout({x_expand: true});
        const name = new St.Label({text: this._label, style_class: 'gtb-row-name'});
        this._statusLabel = new St.Label({
            text: STATE_TEXT[this._state] ?? STATE_TEXT.unknown,
            style_class: 'gtb-row-value',
        });
        this._statusLabel.x_expand = true;
        this._statusLabel.x_align = Clutter.ActorAlign.END;
        box.add_child(name);
        box.add_child(this._statusLabel);
        this._row.add_child(box);
        // The row carries custom children; hide the default empty label.
        this._row.label.visible = false;
        this._row.connect('activate', () => this._onRowActivated());

        const section = new PopupMenu.PopupMenuSection();
        section.addMenuItem(this._row);
        menu.addMenuItem(section);
    }

    enable() {
        this._strikes = 0;
        this._present = false;
        this._setState(ProbeState.UNKNOWN);
        Logger.debug(`gnome-toolbox: playerfix watching ${this._guard.busName}`);

        // Refreshing when the dropdown opens keeps the readout honest while
        // the automatic path is off (then nothing polls in the background).
        const menu = this.ctx.indicator?.menu;
        if (menu) {
            this._menuId = menu.connect('open-state-changed', (_menu, open) => {
                if (open)
                    this._probe(false);
            });
        }

        this._settingsId = this.ctx.settings.connect('changed', (_settings, key) => {
            if (key === 'player-auto-fix' || key === 'player-watch-interval')
                this._schedule();
        });

        this._guard.watch(() => this._onAppeared(), () => this._onVanished());
        this._probe(false);
    }

    disable() {
        this._clearTimer();

        if (this._menuId) {
            this.ctx.indicator?.menu?.disconnect(this._menuId);
            this._menuId = 0;
        }
        if (this._settingsId) {
            this.ctx.settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }

        this._guard.unwatch();
        this._row = null;
        this._statusLabel = null;
        this._present = false;
        this._busy = false;
    }

    _onAppeared() {
        this._present = true;
        this._strikes = 0;
        this._setState(ProbeState.UNKNOWN);
        this._schedule(FIRST_PROBE_DELAY_S);
    }

    _onVanished() {
        this._present = false;
        this._strikes = 0;
        this._clearTimer();
        this._setState(ProbeState.ABSENT);
    }

    _onRowActivated() {
        // Manual path: the user asked, so a timed-out probe is acted on at
        // once instead of waiting for every strike to line up.
        this._probe(true);
    }

    async _probe(manual) {
        if (this._busy)
            return;

        this._busy = true;
        if (manual)
            this._setState(ProbeState.PROBING);

        try {
            const result = await this._guard.probe(PING_TIMEOUT_MS);
            this._present = result.state !== ProbeState.ABSENT;

            switch (result.state) {
            case ProbeState.ABSENT:
                this._strikes = 0;
                this._setState(ProbeState.ABSENT);
                if (manual)
                    this._osd('视频播放器未在运行');
                break;
            case ProbeState.HEALTHY:
                this._strikes = 0;
                this._setState(ProbeState.HEALTHY);
                if (manual)
                    this._osd('视频播放器运行正常');
                break;
            case ProbeState.HUNG:
                this._strikes += 1;
                this._setState(ProbeState.HUNG);
                await this._maybeFix(result.pid, manual);
                break;
            default:
                // A failed ping that was not a timeout says nothing about the
                // process; keep the strikes where they are.
                this._setState(ProbeState.UNKNOWN);
                if (manual)
                    this._osd('无法判断视频播放器状态');
                break;
            }
        } catch (e) {
            Logger.warn(`gnome-toolbox: player probe failed: ${e.message}`);
            this._setState(ProbeState.UNKNOWN);
        } finally {
            this._busy = false;
            this._schedule();
        }
    }

    async _maybeFix(pid, manual) {
        // A probe can outlive a hot-disable: never touch the player on behalf
        // of a feature that is already switched off.
        if (!this.active)
            return;
        if (!manual &&
            (!this.ctx.settings.get_boolean('player-auto-fix') ||
             this._strikes < AUTO_STRIKES))
            return;

        if (!pid) {
            this._osd('视频播放器无响应，但取不到进程号');
            return;
        }

        Logger.warn(`gnome-toolbox: killing wedged player pid ${pid}`);
        const freed = await this._guard.kill(pid);
        this._strikes = 0;

        if (freed) {
            this._present = false;
            this._setState(ProbeState.ABSENT);
            this._osd(manual
                ? '已结束卡死的视频播放器，重新打开即可'
                : '视频播放器卡死，已自动结束');
        } else {
            this._setState(ProbeState.HUNG);
            this._osd('视频播放器无响应，且未能结束进程');
        }
    }

    _schedule(delaySeconds = 0) {
        this._clearTimer();
        if (!this.active || !this._present)
            return;
        if (!this.ctx.settings.get_boolean('player-auto-fix'))
            return;

        const interval = Math.max(3,
            this.ctx.settings.get_int('player-watch-interval'));
        const seconds = delaySeconds > 0 ? delaySeconds : interval;

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timerId = 0;
            this._probe(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _setState(state) {
        this._state = state;
        if (this._statusLabel)
            this._statusLabel.text = STATE_TEXT[state] ?? STATE_TEXT.unknown;
    }

    _osd(message) {
        Main.osdWindowManager.showAll(OSD_ICON, message);
    }
}
