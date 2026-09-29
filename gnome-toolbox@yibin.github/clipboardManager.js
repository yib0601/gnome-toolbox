// Clipboard history manager for GNOME Shell 51.
// Listens to Meta selection owner changes and St.Clipboard, keeps a
// deduplicated text history, supports set/paste.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const TEXT_TYPES = [
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
];

const MAX_ENTRY_LENGTH = 10000;

export class ClipboardManager extends Signals.EventEmitter {
    constructor(settings) {
        super();

        this._settings = settings;
        this._clipboard = St.Clipboard.get_default();
        this._history = [];
        this._privacy = false;
        this._lastContent = null;
        this._busy = false;

        const display = Shell.Global.get().get_display();
        this._selection = display.get_selection();
        this._selectionId = this._selection.connect('owner-changed',
            (selection, selectionType) => {
                if (selectionType === Meta.SelectionType.CLIPBOARD)
                    this._onSelectionChanged();
            });

        this._settingsChangedId = settings.connect('changed::history-size',
            () => this._trim());
    }

    get history() {
        return this._history;
    }

    get privateMode() {
        return this._privacy;
    }

    setPrivateMode(enabled) {
        this._privacy = enabled;
        if (enabled)
            this.clearHistory();
        this.emit('privacy-changed', enabled);
    }

    _onSelectionChanged() {
        if (this._privacy || this._busy)
            return;
        this._fetch(text => {
            if (!text || text === this._lastContent)
                return;
            this._lastContent = text;
            this._push(text);
        });
    }

    _fetch(done) {
        let settled = false;
        const settle = text => {
            if (!settled) {
                settled = true;
                done(text);
            }
        };
        this._busy = true;
        this._clipboard.get_content(St.ClipboardType.CLIPBOARD,
            TEXT_TYPES[0], (clipboard, bytes) => {
                this._busy = false;
                if (bytes === null || bytes.get_size() === 0) {
                    settle(null);
                    return;
                }
                let text = null;
                try {
                    text = new TextDecoder().decode(bytes.get_data());
                } catch (e) {
                    settle(null);
                    return;
                }
                settle(text);
            });
        // safety: never block future updates
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._busy = false;
            return GLib.SOURCE_REMOVE;
        });
        void timeoutId;
    }

    _push(text) {
        if (!text.trim())
            return;
        const entry = text.length > MAX_ENTRY_LENGTH
            ? text.slice(0, MAX_ENTRY_LENGTH)
            : text;
        const idx = this._history.indexOf(entry);
        if (idx === 0)
            return;
        if (idx > 0)
            this._history.splice(idx, 1);
        this._history.unshift(entry);
        this._trim();
        this.emit('history-changed');
    }

    _trim() {
        const max = this._settings.get_int('history-size');
        if (this._history.length > max)
            this._history.length = max;
    }

    setClip(text) {
        this._busy = true;
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        this._lastContent = text;
        this._push(text);
        // set_text triggers a selection change; re-arm after it settles
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._busy = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    paste(text) {
        this.setClip(text);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._simulatePaste();
            return GLib.SOURCE_REMOVE;
        });
    }

    _simulatePaste() {
        try {
            // GNOME 51: Clutter.get_default_backend() removed, reach the
            // backend through the stage's Clutter.Context.
            const backend = Clutter.get_default_backend
                ? Clutter.get_default_backend()
                : global.stage.get_context().get_backend();
            const seat = backend.get_default_seat();
            const device = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const t = Clutter.get_current_event_time() * 1000;
            device.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            device.notify_keyval(t + 1000, Clutter.KEY_Insert, Clutter.KeyState.PRESSED);
            device.notify_keyval(t + 2000, Clutter.KEY_Insert, Clutter.KeyState.RELEASED);
            device.notify_keyval(t + 3000, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
            device.run_dispose();
        } catch (e) {
            log(`gnome-toolbox: paste simulation failed: ${e.message}`);
        }
    }

    clearHistory() {
        this._history = [];
        this._lastContent = null;
        this.emit('history-changed');
    }

    destroy() {
        this._selection.disconnect(this._selectionId);
        if (this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);
        this.emit('destroy');
    }
}
