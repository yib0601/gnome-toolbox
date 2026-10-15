// Notification auto-hide feature: a notification banner that nobody is looking
// at keeps sitting over the top bar - the shell only runs its own auto-hide
// timeout while the user was active when the banner appeared, so a bubble can
// stay there indefinitely. This feature puts a countdown on every banner that
// actually reaches the screen and then collapses it through the shell's own
// expiry path: the notification is not lost, it drops into the notification
// list of the calendar drop-down (the panel unread dot stays).
//
// Everything here is driven off MessageTray._updateState(): GNOME 51 exposes no
// banner-shown / banner-hidden signal and no banner-hints property on
// Notification (verified against shell-src/ui/messageTray.js), and that state
// machine is the single funnel every banner transition goes through.
//
// The countdown only starts once the banner is fully SHOWN. SHOWING is halfway
// through the entry animation; HIDING/HIDDEN mean the bubble is gone or going.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {PanelFeature} from '../core/feature.js';

// Private shell API used to dismiss a banner. Probed on every run so a future
// shell release that renames it only costs us the feature (logged once).
const EXPIRE_METHOD = '_expireNotification';

// Slack around the banner actor when testing whether the pointer rests on it.
const POINTER_SLACK = 8;

export class NotificationAutoHideFeature extends PanelFeature {
    constructor(ctx) {
        super(ctx);
        this._tray = null;
        this._originalUpdateState = null;
        this._hookedUpdateState = null;
        this._timeoutId = 0;
        this._settingsChangedId = 0;
        this._currentNotification = null;
        // Notification whose banner survived one collapse attempt; a second
        // miss for the same one stops the retry. _gaveUpFor remembers a banner
        // the shell refuses to collapse, so the fail-safe in _sync() cannot
        // keep re-arming for it.
        this._retryFor = null;
        this._gaveUpFor = null;
        this._warned = false;
    }

    get id() {
        return 'notifications';
    }

    get settingsKey() {
        return 'enable-notification-autohide';
    }

    // No panel actor and no menu entry: the countdown is the whole effect, the
    // switch lives in preferences.
    enable() {
        const tray = Main.messageTray;
        if (!tray) {
            // Only reachable if Main started without a message tray; stay
            // installed but inert instead of failing silently later on.
            log('gnome-toolbox: Main.messageTray is unavailable, notification auto-hide stays off');
            return;
        }

        this._tray = tray;
        this._originalUpdateState = tray._updateState;
        this._hookedUpdateState = () => {
            try {
                this._originalUpdateState.call(tray);
            } finally {
                // Also keeps the countdown alive if the shell state machine
                // itself threw; swallowing the error would hide shell bugs, so
                // only the bookkeeping is guaranteed here.
                this._sync();
            }
        };
        tray._updateState = this._hookedUpdateState;

        this._settingsChangedId = this.ctx.settings.connect('changed',
            (_settings, key) => {
                if (key === 'notification-hide-delay' ||
                    key === 'auto-hide-critical-notifications') {
                    this._currentNotification = null;
                    this._sync();
                }
            });

        // Enabling (or reloading) while a banner is already up must not leave
        // that banner without a countdown.
        this._sync();
    }

    disable() {
        this._clearTimer();

        const tray = this._tray;
        if (tray && this._hookedUpdateState && tray._updateState === this._hookedUpdateState)
            tray._updateState = this._originalUpdateState;

        this._tray = null;
        this._originalUpdateState = null;
        this._hookedUpdateState = null;
        this._currentNotification = null;
        this._retryFor = null;
        this._gaveUpFor = null;

        if (this._settingsChangedId) {
            this.ctx.settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
    }

    // Runs after every shell state-machine pass: arm the countdown once a
    // banner is fully shown, drop it as soon as that banner goes away.
    _sync() {
        const tray = this._tray;
        if (!tray)
            return;

        const notification = tray._notification;
        if (!notification || tray._notificationState !== MessageTray.State.SHOWN) {
            this._clearTimer();
            this._currentNotification = null;
            return;
        }

        if (notification !== this._currentNotification) {
            this._currentNotification = notification;
            this._retryFor = null;
            this._gaveUpFor = null;
            this._arm();
            return;
        }

        // The shell refuses to collapse this one; retrying forever would just
        // re-arm every delay seconds.
        if (notification === this._gaveUpFor)
            return;

        // A banner sitting in SHOWN with no countdown left would stay there
        // forever, e.g. after the shell swallowed one attempt.
        if (!this._timeoutId)
            this._arm();
    }

    _arm() {
        this._clearTimer();

        const notification = this._tray?._notification;
        if (!notification)
            return;

        if (typeof this._tray[EXPIRE_METHOD] !== 'function') {
            if (!this._warned) {
                this._warned = true;
                log(`gnome-toolbox: Main.messageTray.${EXPIRE_METHOD}() is gone, notification auto-hide stays off`);
            }
            return;
        }

        if (this._isCritical(notification) && !this._hidesCritical())
            return;

        const seconds = Math.max(1, this._delaySeconds());
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, seconds * 1000, () => {
            this._timeoutId = 0;
            this._collapse();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._timeoutId, '[gnome-toolbox] notification auto-hide');
    }

    _collapse() {
        const tray = this._tray;
        const notification = tray?._notification;
        if (!tray || !notification || tray._notificationState !== MessageTray.State.SHOWN) {
            this._currentNotification = null;
            return;
        }

        if (this._isCritical(notification) && !this._hidesCritical())
            return;

        // Never yank a banner the user is reading or pointing at. The test has
        // to be the pointer against the banner actor itself: _bannerBin spans
        // the whole monitor (shell-src:745), _notificationHovered is merely
        // _bannerBin.hover (shell-src:977), and "expanded" is unusable because
        // the shell auto-expands CRITICAL and force-expanded sources
        // (shell-src:1175-1177) - which would make the critical switch below a
        // no-op and re-arm the timer forever. _pointerInNotification alone is
        // not enough either: when a banner pops up under the pointer the shell
        // deliberately leaves it false and does not expand (shell-src:981-995).
        if (tray._pointerInNotification || this._pointerOnBanner(tray)) {
            this._arm();
            return;
        }

        // shell-src gates its own auto-hide timeout on
        // `_userActiveWhileNotificationShown`, which records whether the user
        // was active when the banner appeared (shell-src:1131,
        // get_idletime() <= 1000). When the user was away, the shell skips its
        // timeout entirely and waits for the next activity, so the bubble can
        // sit on screen for as long as nobody touches the machine - and since
        // the pointer is idle too, the guards above do not hold it back.
        // `_expireNotification()` (the Escape key path) is not gated that way,
        // which is what makes this collapse land at all.
        //
        // It is swallowed while the shell is inside its own state pass, while
        // banners are blocked or when there is no monitor at all
        // (shell-src:1061-1069), and that early return also skips the
        // `_notificationExpired` reset at shell-src:1118 - leaving the flag set
        // would make the *next* banner collapse instantly. So skip the call
        // when it cannot land, and clear the flag if it landed nowhere.
        if (tray._updatingState || tray._bannerBlocked ||
            Main.layoutManager.primaryMonitor == null) {
            // Nothing was attempted, so this must not cost the retry budget: a
            // user reading the menu with the panel open can block banners for
            // minutes, and giving up here would leave the bubble stuck forever.
            this._arm();
            return;
        }

        tray[EXPIRE_METHOD]();

        if (tray._notification === notification &&
            tray._notificationState === MessageTray.State.SHOWN) {
            tray._notificationExpired = false;

            // This one really was attempted and the shell declined: retry once,
            // then stop re-arming for this notification. _gaveUpFor is what
            // keeps _sync() from treating it as a fresh banner and looping.
            if (this._retryFor === notification) {
                log('gnome-toolbox: banner did not collapse, giving up on this notification');
                this._gaveUpFor = notification;
                return;
            }
            this._retryFor = notification;
            this._arm();
        }
    }

    // Pointer geometry against the banner actor (shell-src:1138).
    _pointerOnBanner(tray) {
        const banner = tray._banner;
        if (!banner || typeof banner.get_transformed_position !== 'function')
            return false;

        const [x, y] = global.get_pointer();
        const [bx, by] = banner.get_transformed_position();
        const width = banner.width;
        const height = banner.height;
        if (!width || !height) {
            // Geometry not laid out yet: assume the pointer may be on it and
            // push the collapse out rather than yanking a banner we cannot
            // measure.
            return true;
        }

        return x >= bx - POINTER_SLACK && x <= bx + width + POINTER_SLACK &&
            y >= by - POINTER_SLACK && y <= by + height + POINTER_SLACK;
    }

    _isCritical(notification) {
        return notification.urgency === MessageTray.Urgency.CRITICAL;
    }

    _delaySeconds() {
        return this.ctx.settings.get_int('notification-hide-delay');
    }

    _hidesCritical() {
        return this.ctx.settings.get_boolean('auto-hide-critical-notifications');
    }

    _clearTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }
}