// Combined panel indicator: vitals summary + lock keys state on the top
// bar, with a single drop-down menu holding vitals details, lock key
// switches and clipboard history.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {VitalsSampler, formatBytes, formatBytesStatic} from './vitals.js';

const CLIP_LABEL_MAX = 42;

export const ToolboxIndicator = GObject.registerClass(
class ToolboxIndicator extends PanelMenu.Button {
    _init(extension, settings, clipboardManager) {
        super._init(0.0, 'ToolboxIndicator');

        this._extension = extension;
        this._settings = settings;
        this._clipManager = clipboardManager;
        this._sampler = new VitalsSampler();
        this._timeoutId = 0;

        // ---- top bar actor ----
        this._actor = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'gtb-panel',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._cpuLabel = new St.Label({style_class: 'gtb-panel-item', y_align: Clutter.ActorAlign.CENTER});
        this._memLabel = new St.Label({style_class: 'gtb-panel-item', y_align: Clutter.ActorAlign.CENTER});
        this._netLabel = new St.Label({style_class: 'gtb-panel-item', y_align: Clutter.ActorAlign.CENTER});
        this._lockLabel = new St.Label({style_class: 'gtb-panel-item gtb-lock', y_align: Clutter.ActorAlign.CENTER});

        this._actor.add_child(this._cpuLabel);
        this._actor.add_child(this._memLabel);
        this._actor.add_child(this._netLabel);
        this._actor.add_child(this._lockLabel);
        this.add_child(this._actor);

        // ---- menu: vitals section ----
        this._vitalsSection = new PopupMenu.PopupMenuSection();
        this._vitalsRows = {};
        const vitalsDef = [
            ['cpu', 'CPU'],
            ['mem', '内存'],
            ['temp', '温度'],
            ['disk', '磁盘'],
            ['netDown', '下行网速'],
            ['netUp', '上行网速'],
        ];
        for (const [key, title] of vitalsDef) {
            const row = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
            const box = new St.BoxLayout({expand: true});
            const nameLabel = new St.Label({text: title, style_class: 'gtb-row-name'});
            const valueLabel = new St.Label({text: '—', style_class: 'gtb-row-value'});
            valueLabel.x_expand = true;
            valueLabel.x_align = Clutter.ActorAlign.END;
            box.add_child(nameLabel);
            box.add_child(valueLabel);
            row.add_child(box);
            row.label.visible = false;
            this._vitalsRows[key] = valueLabel;
            this._vitalsSection.addMenuItem(row);
        }
        this.menu.addMenuItem(this._vitalsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ---- menu: lock keys ----
        this._numLockItem = new PopupMenu.PopupSwitchMenuItem('Num Lock', false);
        this._capsLockItem = new PopupMenu.PopupSwitchMenuItem('Caps Lock', false);
        this._numLockItem.connect('toggled', item => this._setLockKey('num', item.state));
        this._capsLockItem.connect('toggled', item => this._setLockKey('caps', item.state));
        this.menu.addMenuItem(this._numLockItem);
        this.menu.addMenuItem(this._capsLockItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ---- menu: clipboard ----
        const clipHeader = new PopupMenu.PopupMenuItem('剪贴板历史', {reactive: false, can_focus: false});
        clipHeader.actor.add_style_class_name('gtb-section-header');
        this.menu.addMenuItem(clipHeader);

        this._privacyItem = new PopupMenu.PopupSwitchMenuItem('隐私模式', false);
        this._privacyItem.connect('toggled', item => {
            this._clipManager.setPrivateMode(item.state);
        });
        this.menu.addMenuItem(this._privacyItem);

        this._clearItem = new PopupMenu.PopupMenuItem('清空历史');
        this._clearItem.connect('activate', () => this._clipManager.clearHistory());
        this.menu.addMenuItem(this._clearItem);

        this._historySection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._historySection);

        this._menuActorId = this.menu.actor.connect('destroy', () => {
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
        });
    }

    // Called by the extension after creation
    start(settings, keyMap) {
        this._settingsChangedId = this._settings.connect('changed', (s, k) =>
            this._onSettingChanged(k));
        this._onSettingChanged(null);

        this._keyMap = keyMap;
        if (this._keyMap) {
            this._keymapId = this._keyMap.connect('state-changed',
                () => this._updateLockState());
        }
        this._updateLockState();

        this._clipManagerId = this._clipManager.connect('history-changed', () =>
            this._renderHistory());
        this._clipPrivacyId = this._clipManager.connect('privacy-changed',
            (mgr, enabled) => this._privacyItem.setToggleState(enabled));
        this._renderHistory();

        this._refresh();
        const interval = Math.max(1, this._settings.get_int('update-interval'));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            interval, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _onSettingChanged(key) {
        const s = this._settings;
        this._cpuLabel.visible = s.get_boolean('show-cpu');
        this._memLabel.visible = s.get_boolean('show-mem');
        this._netLabel.visible = s.get_boolean('show-net');
        this._lockLabel.visible = s.get_boolean('show-lock-keys');

        if (key === 'update-interval') {
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
            const interval = Math.max(1, s.get_int('update-interval'));
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                interval, () => {
                    this._refresh();
                    return GLib.SOURCE_CONTINUE;
                });
        }
    }

    _refresh() {
        const v = this._sampler.sample();
        if (v.cpu !== null) {
            this._cpuLabel.set_text(`${Math.round(v.cpu)}%`);
            this._vitalsRows.cpu.set_text(`${v.cpu.toFixed(1)} %`);
        }
        if (v.memUsedPct !== null) {
            this._memLabel.set_text(`${Math.round(v.memUsedPct)}%`);
            this._vitalsRows.mem.set_text(
                `${formatBytesStatic(v.memUsed)} / ${formatBytesStatic(v.memTotal)} (${v.memUsedPct.toFixed(0)}%)`);
        }
        if (v.netDown !== null || v.netUp !== null) {
            const d = formatBytes(v.netDown);
            const u = formatBytes(v.netUp);
            this._netLabel.set_text(`↓${d} ↑${u}`);
            this._vitalsRows.netDown.set_text(d);
            this._vitalsRows.netUp.set_text(u);
        }
        if (v.temp !== null)
            this._vitalsRows.temp.set_text(`${v.temp.toFixed(1)} °C`);
        if (v.diskUsedPct !== null)
            this._vitalsRows.disk.set_text(`${v.diskUsedPct.toFixed(0)} % 已用`);
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
        this._numLockItem.setToggleState(num);
        this._capsLockItem.setToggleState(caps);
        const text = [num ? 'N' : '', caps ? 'C' : ''].filter(Boolean).join('');
        this._lockLabel.set_text(text);
        this._lockLabel.visible = text !== '' && this._settings.get_boolean('show-lock-keys');
    }

    _setLockKey(kind, state) {
        if (!this._keyMap)
            return;
        try {
            const backend = Clutter.get_default_backend
                ? Clutter.get_default_backend()
                : global.stage.get_context().get_backend();
            const seat = backend.get_default_seat();
            const device = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const t = Clutter.get_current_event_time() * 1000;
            const key = kind === 'num' ? Clutter.KEY_Num_Lock : Clutter.KEY_Caps_Lock;
            device.notify_keyval(t, key, Clutter.KeyState.PRESSED);
            device.notify_keyval(t + 1000, key, Clutter.KeyState.RELEASED);
            device.run_dispose();
        } catch (e) {
            log(`gnome-toolbox: lock key toggle failed: ${e.message}`);
        }
    }

    _renderHistory() {
        this._historySection.removeAll();
        const history = this._clipManager.history;
        const pasteOnSelect = this._settings.get_boolean('paste-on-select');

        if (!history.length) {
            const empty = new PopupMenu.PopupMenuItem('（空）', {reactive: false, can_focus: false});
            empty.actor.add_style_class_name('gtb-dim');
            this._historySection.addMenuItem(empty);
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
            this._historySection.addMenuItem(item);
        }
    }

    _onDestroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._keyMap && this._keymapId) {
            this._keyMap.disconnect(this._keymapId);
            this._keymapId = 0;
        }
        if (this._clipManagerId)
            this._clipManager.disconnect(this._clipManagerId);
        if (this._clipPrivacyId)
            this._clipManager.disconnect(this._clipPrivacyId);
        if (this._menuActorId) {
            this.menu.actor.disconnect(this._menuActorId);
            this._menuActorId = 0;
        }
        super._onDestroy();
    }
});
