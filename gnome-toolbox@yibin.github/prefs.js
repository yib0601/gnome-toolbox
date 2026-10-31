// Preferences for gnome-toolbox: panel placement (section + order),
// which readouts show up, and clipboard behaviour.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PANEL_BOXES = [
    {value: 'left', label: '左侧'},
    {value: 'center', label: '中间'},
    {value: 'right', label: '右侧'},
];

// Settings are written straight from the row signals instead of using
// Gio.Settings.bind(): SpinRow/ComboRow use double and index types that do
// not match the schema types.

function bindSwitch(settings, key, row) {
    row.active = settings.get_boolean(key);
    row.connect('notify::active', () => settings.set_boolean(key, row.active));
    settings.connect(`changed::${key}`, () => {
        row.active = settings.get_boolean(key);
    });
}

function bindSpin(settings, key, row) {
    row.value = settings.get_int(key);
    row.connect('notify::value', () => settings.set_int(key, Math.round(row.value)));
    settings.connect(`changed::${key}`, () => {
        row.value = settings.get_int(key);
    });
}

function bindCombo(settings, key, row, choices) {
    row.model = Gtk.StringList.new(choices.map(c => c.label));
    row.selected = Math.max(0, choices.findIndex(c => c.value === settings.get_string(key)));
    row.connect('notify::selected', () => {
        const choice = choices[row.selected];
        if (choice)
            settings.set_string(key, choice.value);
    });
    settings.connect(`changed::${key}`, () => {
        const index = choices.findIndex(c => c.value === settings.get_string(key));
        if (index >= 0 && index !== row.selected)
            row.selected = index;
    });
}

function spinRow(title, subtitle, lower, upper) {
    return new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: 1,
            page_increment: 5,
        }),
    });
}

// Key-capture row for an `as` accelerator key. Adw.EntryRow gives the
// "labelled field with a clear button" look for free; the entry stays editable
// (a non-editable entry is not focusable and would never see a key press) but
// every key is stopped in the CAPTURE phase before the text machinery runs, so
// nothing ever gets typed into it.
function shortcutRow(settings, key, title, subtitle) {
    const row = new Adw.EntryRow({title});
    if (subtitle)
        row.tooltip_text = subtitle;

    // Show the stored accelerator in canonical form (the schema could hold
    // any spelling GLib accepts, e.g. <Ctrl><Alt>v).
    const setLabel = () => {
        const [accel] = settings.get_strv(key);
        if (!accel) {
            row.text = '';
            return;
        }
        const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
        row.text = ok ? Gtk.accelerator_name(keyval, mods) : accel;
    };
    setLabel();

    const controller = new Gtk.EventControllerKey();
    controller.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
        if (keyval === Gdk.KEY_Escape || keyval === Gdk.KEY_BackSpace ||
            keyval === Gdk.KEY_Delete) {
            settings.set_strv(key, []);
            setLabel();
            return Gdk.EVENT_STOP;
        }
        // Ignore a bare modifier press: the user is still building the combo.
        if (getModifierKeys().has(keyval))
            return Gdk.EVENT_STOP;

        const mods = state & Gtk.accelerator_get_default_mod_mask();
        // Shift+letter is technically a "valid" accelerator but binding it
        // globally would swallow ordinary capitalised typing, so require a
        // real command modifier.
        if (!requiredModifierPressed(mods) || !Gtk.accelerator_valid(keyval, mods))
            return Gdk.EVENT_STOP;

        const name = Gtk.accelerator_name(keyval, mods);
        if (name) {
            settings.set_strv(key, [name]);
            setLabel();
        }
        return Gdk.EVENT_STOP;
    });
    row.add_controller(controller);

    settings.connect(`changed::${key}`, setLabel);
    return row;
}

// Ctrl, Alt, Super, Meta or Hyper - everything but Shift. Gtk.accelerator_valid()
// alone accepts Shift-only combinations, which are unusable as global shortcuts.
function requiredModifierPressed(mods) {
    return (mods & COMMAND_MODIFIER_MASK) !== 0;
}

// Modifier keyvals, ignored while the user is still holding the combination
// together. Built lazily because Gdk constants need the loaded namespace.
let _modifierKeys = null;
function getModifierKeys() {
    if (!_modifierKeys) {
        _modifierKeys = new Set([
            Gdk.KEY_Control_L, Gdk.KEY_Control_R,
            Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
            Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
            Gdk.KEY_Super_L, Gdk.KEY_Super_R,
            Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
            Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
        ]);
    }
    return _modifierKeys;
}

// Everything except Shift: the modifiers that make a combination safe to bind
// globally instead of stealing plain typing.
const COMMAND_MODIFIER_MASK = Gdk.ModifierType.CONTROL_MASK |
    Gdk.ModifierType.ALT_MASK |
    Gdk.ModifierType.SUPER_MASK |
    Gdk.ModifierType.META_MASK |
    Gdk.ModifierType.HYPER_MASK;

export default class GnomeToolboxPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: '工具箱',
            icon_name: 'utilities-system-monitor-symbolic',
        });

        page.add(this._switchGroup(settings));
        page.add(this._placementGroup(settings));
        page.add(this._readoutsGroup(settings));
        page.add(this._clipboardGroup(settings));
        page.add(this._screenshotGroup(settings));
        page.add(this._notificationGroup(settings));

        window.add(page);
        window.search_enabled = true;
    }

    _switchGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: '功能开关',
            description: '各功能可单独启停，改动即时生效，无需注销。',
        });

        const items = [
            ['enable-vitals', '系统监控', '顶栏 CPU/内存/网速，菜单内温度与磁盘用量'],
            ['enable-lock-keys', '锁定键指示', '跟踪 Num/Caps Lock 状态，变化时弹出 OSD 提示'],
            ['enable-clipboard', '剪贴板历史', '文本历史记录、隐私模式与清空'],
            ['enable-tray', '托盘图标（AppIndicator）', '接管 StatusNotifierItem 图标；遗留 XEmbed 托盘由下方 legacy-tray-enabled 单独控制'],
        ];
        for (const [key, title, subtitle] of items) {
            const row = new Adw.SwitchRow({title, subtitle});
            bindSwitch(settings, key, row);
            group.add(row);
            if (key === 'enable-lock-keys') {
                // OSD toast is a sub-option of the lock-keys feature, not a
                // top-bar readout, so it lives here instead of the readouts
                // group.
                const osdRow = new Adw.SwitchRow({
                    title: '锁定键 OSD 提示',
                    subtitle: 'Num/Caps 变化时弹出屏显提示',
                });
                bindSwitch(settings, 'show-lock-keys', osdRow);
                group.add(osdRow);
            }
        }

        return group;
    }

    _placementGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: '顶栏位置',
            description: '决定监控指示器出现在顶栏的哪个区域，以及在该区域中的排序。改动即时生效。',
        });

        const boxRow = new Adw.ComboRow({
            title: '显示区域',
            subtitle: '左侧 / 中间 / 右侧',
        });
        bindCombo(settings, 'panel-box', boxRow, PANEL_BOXES);
        group.add(boxRow);

        const orderRow = spinRow('排序序号', '数字越小越靠左；超出该区域已有项数则排到最右端',
            0, 99);
        bindSpin(settings, 'panel-position', orderRow);
        group.add(orderRow);

        return group;
    }

    _readoutsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: '顶栏读数',
            description: '关闭某项后顶栏不再显示该项；顶栏已有的读数不会重复出现在下拉菜单里。',
        });

        const items = [
            ['show-cpu', 'CPU 占用'],
            ['show-mem', '内存占用'],
            ['show-net', '网络速率'],
        ];
        for (const [key, title] of items) {
            const row = new Adw.SwitchRow({title});
            bindSwitch(settings, key, row);
            group.add(row);
        }

        const intervalRow = spinRow('刷新间隔（秒）', '采样 CPU、内存、网络的周期',
            1, 60);
        bindSpin(settings, 'update-interval', intervalRow);
        group.add(intervalRow);

        return group;
    }

    _clipboardGroup(settings) {
        const group = new Adw.PreferencesGroup({title: '剪贴板'});

        const sizeRow = spinRow('历史条数', '最多保留多少条记录', 1, 100);
        bindSpin(settings, 'history-size', sizeRow);
        group.add(sizeRow);

        const imagesRow = new Adw.SwitchRow({
            title: '记录图片',
            subtitle: '截图只提供 image/* 类型，关闭后截图不会进入历史',
        });
        bindSwitch(settings, 'history-include-images', imagesRow);
        group.add(imagesRow);

        const maxLenRow = new Adw.SpinRow({
            title: '单条最大长度',
            subtitle: '超出部分截断后入库（字符数）',
            adjustment: new Gtk.Adjustment({
                lower: 500,
                upper: 100000,
                step_increment: 100,
                page_increment: 1000,
            }),
        });
        bindSpin(settings, 'max-entry-length', maxLenRow);
        group.add(maxLenRow);

        const pasteRow = new Adw.SwitchRow({
            title: '选中即粘贴',
            subtitle: '选中历史条目后自动模拟 Shift+Insert，而不只是写入剪贴板',
        });
        bindSwitch(settings, 'paste-on-select', pasteRow);
        group.add(pasteRow);

        const osdRow = new Adw.SwitchRow({
            title: '复制 OSD 提示',
            subtitle: '复制新内容时弹出屏显提示',
        });
        bindSwitch(settings, 'show-clipboard-osd', osdRow);
        group.add(osdRow);

        return group;
    }

    _screenshotGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: '截图格式',
            description: '微信 Alt+A 等 Qt 截图工具把 BMP 字节挂在 image/png 名下，' +
                '浏览器和 DSH 按声明类型校验时会拒收。开启后按字节真实格式转成 PNG 再写回剪贴板。',
        });

        const masterRow = new Adw.SwitchRow({
            title: '截图转 PNG',
            subtitle: '菜单项与下方快捷键的唯一开关',
        });
        bindSwitch(settings, 'normalize-screenshots', masterRow);
        group.add(masterRow);

        const keyRow = shortcutRow(settings, 'normalize-shortcut',
            '转换快捷键',
            '按下目标组合键即可录入；Backspace/Delete/Esc 清除');
        group.add(keyRow);

        const autoRow = new Adw.SwitchRow({
            title: '复制时自动转换',
            subtitle: '截图一进剪贴板就转好，无需按快捷键；会接管剪贴板所有权',
        });
        bindSwitch(settings, 'normalize-on-copy', autoRow);
        group.add(autoRow);

        this._followSwitch(settings, masterRow, [keyRow, autoRow]);

        return group;
    }

    _notificationGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: '通知',
            description: '气泡通知在顶栏停留的时间。收起后通知进入顶部日历的通知列表，不会被丢弃；鼠标停在气泡上时推迟收起，移开后重新计时。',
        });

        const delayRow = spinRow('收起延迟（秒）', '气泡完整显示多久后自动收起',
            1, 120);
        bindSpin(settings, 'notification-hide-delay', delayRow);

        const criticalRow = new Adw.SwitchRow({
            title: '同时收起紧急通知',
            subtitle: '紧急（critical）通知默认常驻顶栏，直到手动关闭',
        });
        bindSwitch(settings, 'auto-hide-critical-notifications', criticalRow);

        // Sub-options of the switch below: kept next to it and greyed out while
        // the feature itself is off.
        const masterRow = new Adw.SwitchRow({
            title: '通知定时关闭',
            subtitle: '气泡通知倒计时结束后自动收起，收进顶部日历的通知列表',
        });
        bindSwitch(settings, 'enable-notification-autohide', masterRow);
        group.add(masterRow);
        group.add(delayRow);
        group.add(criticalRow);
        this._followSwitch(settings, masterRow, [delayRow, criticalRow]);

        return group;
    }

    // Rows that only make sense while another switch is on: disabled (which
    // greys them out) whenever the switch is off.
    _followSwitch(settings, masterRow, rows) {
        const apply = () => {
            for (const row of rows)
                row.sensitive = masterRow.active;
        };
        masterRow.connect('notify::active', apply);
        settings.connect('changed::enable-notification-autohide', apply);
        apply();
    }
}
