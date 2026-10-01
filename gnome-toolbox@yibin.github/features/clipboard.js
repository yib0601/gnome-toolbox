// Clipboard feature: text history with dedup, privacy mode, set/paste.
// Listens to Meta selection owner changes and St.Clipboard.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {PanelFeature} from '../core/feature.js';
import {getVirtualKeyboard} from '../core/input.js';

const TEXT_TYPES = [
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
];

const CLIP_LABEL_MAX = 42;

export class ClipboardManager extends Signals.EventEmitter {
    constructor(settings) {
        super();

        this._settings = settings;
        this._clipboard = St.Clipboard.get_default();
        this._history = [];
        this._privacy = false;
        this._lastContent = null;
        this._busy = false;
        this._destroyed = false;

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
                if (this._destroyed)
                    return;
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
            if (!this._destroyed)
                this._busy = false;
            return GLib.SOURCE_REMOVE;
        });
        void timeoutId;
    }

    _push(text) {
        if (!text.trim())
            return;
        const maxLen = this._settings.get_int('max-entry-length');
        const entry = text.length > maxLen ? text.slice(0, maxLen) : text;
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
            if (!this._destroyed)
                this._simulatePaste();
            return GLib.SOURCE_REMOVE;
        });
    }

    // A virtual device must outlive mutter's asynchronous input-thread
    // dispatch, so use the shared cached device (core/input.js).
    _simulatePaste() {
        const device = getVirtualKeyboard();
        if (!device)
            return;
        try {
            const t = GLib.get_monotonic_time();
            device.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            device.notify_keyval(t + 1000, Clutter.KEY_Insert, Clutter.KeyState.PRESSED);
            device.notify_keyval(t + 2000, Clutter.KEY_Insert, Clutter.KeyState.RELEASED);
            device.notify_keyval(t + 3000, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
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
        this._destroyed = true;
        this._selection.disconnect(this._selectionId);
        if (this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);
        this.emit('destroy');
    }
}

export class ClipboardFeature extends PanelFeature {
    constructor(ctx) {
        super(ctx);
        this._clipManager = ctx.clipboard;
        this._clipManagerId = 0;
        this._clipPrivacyId = 0;
    }

    get id() {
        return 'clipboard';
    }

    get settingsKey() {
        return 'enable-clipboard';
    }

    buildMenu(menu) {
        const clipHeader = new PopupMenu.PopupMenuItem('剪贴板历史', {reactive: false, can_focus: false});
        clipHeader.actor.add_style_class_name('gtb-section-header');
        menu.addMenuItem(clipHeader);

        this._privacyItem = new PopupMenu.PopupSwitchMenuItem('隐私模式', false);
        this._privacyItem.connect('toggled', item => {
            this._clipManager.setPrivateMode(item.state);
        });
        menu.addMenuItem(this._privacyItem);

        this._clearItem = new PopupMenu.PopupMenuItem('清空历史');
        this._clearItem.connect('activate', () => this._clipManager.clearHistory());
        menu.addMenuItem(this._clearItem);

        this._historySection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._historySection);
    }

    enable() {
        this._clipManagerId = this._clipManager.connect('history-changed', () =>
            this._renderHistory());
        // setToggleState() re-emits 'toggled' even when unchanged; only sync
        // when the switch actually differs, or the privacy-changed -> toggled
        // echo feeds back into setPrivateMode and spins the main loop.
        this._clipPrivacyId = this._clipManager.connect('privacy-changed',
            (_mgr, enabled) => {
                if (this._privacyItem && this._privacyItem.state !== enabled)
                    this._privacyItem.setToggleState(enabled);
            });
        this._renderHistory();
    }

    disable() {
        if (this._clipManagerId) {
            this._clipManager.disconnect(this._clipManagerId);
            this._clipManagerId = 0;
        }
        if (this._clipPrivacyId) {
            this._clipManager.disconnect(this._clipPrivacyId);
            this._clipPrivacyId = 0;
        }
    }

    _renderHistory() {
        const section = this._historySection;
        if (!section)
            return;
        section.removeAll();
        const history = this._clipManager.history;
        const pasteOnSelect = this.ctx.settings.get_boolean('paste-on-select');

        if (!history.length) {
            const empty = new PopupMenu.PopupMenuItem('（空）', {reactive: false, can_focus: false});
            empty.actor.add_style_class_name('gtb-dim');
            section.addMenuItem(empty);
            return;
        }

        for (const entry of history) {
            const short = entry.replace(/\s+/g, ' ').trim();
            const label = short.length > CLIP_LABEL_MAX
                ? `${short.slice(0, CLIP_LABEL_MAX)}…`
                : short;
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => {
                if (pasteOnSelect)
                    this._clipManager.paste(entry);
                else
                    this._clipManager.setClip(entry);
            });
            section.addMenuItem(item);
        }
    }
}
