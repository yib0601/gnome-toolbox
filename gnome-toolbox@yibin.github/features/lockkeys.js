// Lock keys feature: read-only Num/Caps Lock state, announced through an
// OSD toast when the state changes. Display only — this feature never
// toggles the lock keys and adds no rows to the menu.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PanelFeature} from '../core/feature.js';
import {getKeymap} from '../core/input.js';

const OSD_ICON = new Gio.ThemedIcon({name: 'input-keyboard-symbolic'});

export class LockKeysFeature extends PanelFeature {
    constructor(ctx) {
        super(ctx);
        this._keyMap = null;
        this._keymapId = 0;
        this._settingsChangedId = 0;
        // null until first successful read; suppresses a toast on enable.
        this._lastState = {num: null, caps: null};
    }

    get id() {
        return 'lockkeys';
    }

    get settingsKey() {
        return 'enable-lock-keys';
    }

    // No top-bar presence: state changes are announced through the OSD.
    panelActors() {
        return [];
    }

    enable() {
        this._keyMap = getKeymap();
        if (this._keyMap) {
            this._keymapId = this._keyMap.connect('state-changed',
                () => this._updateLockState());
        }
        this._settingsChangedId = this.ctx.settings.connect('changed::show-lock-keys',
            () => this._updateLockState());
        this._lastState = {num: null, caps: null};
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
        if (!this._keyMap)
            return;
        let num = false;
        let caps = false;
        try {
            num = this._keyMap.get_num_lock_state();
            caps = this._keyMap.get_caps_lock_state();
        } catch (e) {
            log(`gnome-toolbox: keymap state query failed: ${e.message}`);
        }
        if (this.ctx.settings.get_boolean('show-lock-keys')) {
            const last = this._lastState;
            if (last.num !== null && last.num !== num)
                Main.osdWindowManager.showAll(OSD_ICON, `Num Lock ${num ? '开启' : '关闭'}`);
            if (last.caps !== null && last.caps !== caps)
                Main.osdWindowManager.showAll(OSD_ICON, `Caps Lock ${caps ? '开启' : '关闭'}`);
        }
        this._lastState = {num, caps};
    }
}
