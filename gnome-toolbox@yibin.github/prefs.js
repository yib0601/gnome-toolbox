// Preferences for gnome-toolbox: panel placement (section + order),
// which readouts show up, and clipboard behaviour.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

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

        window.add(page);
        window.search_enabled = true;
    }

    _switchGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: '功能开关',
            description: '各功能可单独启停，改动即时生效，无需注销。',
        });

        const items = [
            ['enable-vitals', '系统监控', '顶栏 CPU/内存/网速，菜单内温度与磁盘详情'],
            ['enable-lock-keys', '锁定键指示', 'Num/Caps Lock 状态变化时 OSD 屏显，菜单内显示当前状态'],
            ['enable-clipboard', '剪贴板历史', '文本历史记录、隐私模式与清空'],
            ['enable-tray', '托盘图标（AppIndicator）', '接管 StatusNotifierItem 图标；遗留 XEmbed 托盘由下方 legacy-tray-enabled 单独控制'],
        ];
        for (const [key, title, subtitle] of items) {
            const row = new Adw.SwitchRow({title, subtitle});
            bindSwitch(settings, key, row);
            group.add(row);
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
            description: '关闭某项后它仍会出现在下拉菜单里详列。',
        });

        const items = [
            ['show-cpu', 'CPU 占用'],
            ['show-mem', '内存占用'],
            ['show-net', '网络速率'],
            ['show-lock-keys', 'Num/Caps Lock OSD 屏显'],
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

        const pasteRow = new Adw.SwitchRow({
            title: '选中即粘贴',
            subtitle: '选中历史条目后自动模拟 Shift+Insert，而不只是写入剪贴板',
        });
        bindSwitch(settings, 'paste-on-select', pasteRow);
        group.add(pasteRow);

        return group;
    }
}
