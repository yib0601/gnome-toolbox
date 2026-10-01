// Lock keys feature: read-only Num/Caps Lock state on the panel and in
// the menu. Display only — this feature never toggles the lock keys.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {PanelFeature} from '../core/feature.js';
import {getKeymap} from '../core/input.js';

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
        // Non-reactive display rows: state is reflected by the row text,
        // never written back to the keyboard.
        this._numLockItem = new PopupMenu.PopupMenuItem('Num Lock: —',
            {reactive: false, can_focus: false});
        this._capsLockItem = new PopupMenu.PopupMenuItem('Caps Lock: —',
            {reactive: false, can_focus: false});
        for (const item of [this._numLockItem, this._capsLockItem])
            item.actor.add_style_class_name('gtb-dim');
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
        if (this._numLockItem)
            this._numLockItem.label.set_text(`Num Lock: ${num ? '开' : '关'}`);
        if (this._capsLockItem)
            this._capsLockItem.label.set_text(`Caps Lock: ${caps ? '开' : '关'}`);
        const text = [num ? 'N' : '', caps ? 'C' : ''].filter(Boolean).join('');
        this._lockLabel.set_text(text);
        this._lockLabel.visible = text !== '' &&
            this.ctx.settings.get_boolean('show-lock-keys');
    }
}
