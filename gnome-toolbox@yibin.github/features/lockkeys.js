// Lock keys feature: Num/Caps Lock state on the panel, toggleable
// switches in the menu. Uses a shared virtual keyboard device to inject
// key events (see core/input.js for the use-after-free rationale).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {PanelFeature} from '../core/feature.js';
import {getKeymap, getVirtualKeyboard} from '../core/input.js';

export class LockKeysFeature extends PanelFeature {
    constructor(ctx) {
        super(ctx);
        this._keyMap = null;
        this._keymapId = 0;
        this._settingsChangedId = 0;
        this._numLockItem = null;
        this._capsLockItem = null;
    }

    get id() {
        return 'lockkeys';
    }

    get settingsKey() {
        return 'enable-lock-keys';
    }

    panelActors() {
        if (!this._lockLabel) {
            this._lockLabel = new St.Label({
                style_class: 'gtb-panel-item gtb-lock',
                y_align: Clutter.ActorAlign.CENTER,
            });
        }
        return [this._lockLabel];
    }

    buildMenu(menu) {
        this._numLockItem = new PopupMenu.PopupSwitchMenuItem('Num Lock', false);
        this._capsLockItem = new PopupMenu.PopupSwitchMenuItem('Caps Lock', false);
        this._numLockItem.connect('toggled', item => this._setLockKey('num', item.state));
        this._capsLockItem.connect('toggled', item => this._setLockKey('caps', item.state));
        menu.addMenuItem(this._numLockItem);
        menu.addMenuItem(this._capsLockItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    enable() {
        this._keyMap = getKeymap();
        if (this._keyMap) {
            this._keymapId = this._keyMap.connect('state-changed',
                () => this._updateLockState());
        }
        this._settingsChangedId = this.ctx.settings.connect('changed::show-lock-keys',
            () => this._updateLockState());
        this._updateLockState();
    }

    disable() {
        if (this._keyMap && this._keymapId) {
            this._keyMap.disconnect(this._keymapId);
            this._keymapId = 0;
        }
        this._keyMap = null;
        if (this._settingsChangedId) {
            this.ctx.settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
    }

    _updateLockState() {
        if (!this._keyMap) {
            this._lockLabel.visible = false;
            return;
        }
        let num = false;
        let caps = false;
        try {
            num = this._keyMap.get_num_lock_state();
            caps = this._keyMap.get_caps_lock_state();
        } catch (e) {
            log(`gnome-toolbox: keymap state query failed: ${e.message}`);
        }
        this._numLockItem?.setToggleState(num);
        this._capsLockItem?.setToggleState(caps);
        const text = [num ? 'N' : '', caps ? 'C' : ''].filter(Boolean).join('');
        this._lockLabel.set_text(text);
        this._lockLabel.visible = text !== '' &&
            this.ctx.settings.get_boolean('show-lock-keys');
    }

    _setLockKey(kind, state) {
        if (!this._keyMap)
            return;
        const device = getVirtualKeyboard();
        if (!device)
            return;
        try {
            // Monotonic clock in microseconds, matching Clutter event times.
            // Clutter.get_current_event_time() returns 0 outside an event.
            const t = GLib.get_monotonic_time();
            const key = kind === 'num' ? Clutter.KEY_Num_Lock : Clutter.KEY_Caps_Lock;
            device.notify_keyval(t, key, Clutter.KeyState.PRESSED);
            device.notify_keyval(t + 1000, key, Clutter.KeyState.RELEASED);
        } catch (e) {
            log(`gnome-toolbox: lock key toggle failed: ${e.message}`);
        }
    }
}
