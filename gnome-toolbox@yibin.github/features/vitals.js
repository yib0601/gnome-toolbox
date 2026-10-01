// Vitals feature: CPU / memory / network on the panel, temperature and
// disk usage in the menu. Owns its sampling timer.
// Data sources: /proc/stat, /proc/meminfo, /proc/net/dev, sysfs thermal.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {PanelFeature} from '../core/feature.js';

// Create a panel-sized symbolic icon shipped inside the extension's icons/ dir.
function panelIcon(name) {
    const file = Gio.File.new_for_uri(import.meta.url).get_parent()
        .get_parent().get_child('icons').get_child(`${name}.svg`);
    const gicon = Gio.FileIcon.new(file);
    return new St.Icon({
        gicon,
        icon_size: 14,
        style_class: 'gtb-panel-icon',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function readFileString(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        let text = contents;
        if (contents instanceof Uint8Array)
            text = new TextDecoder().decode(contents);
        return text;
    } catch (e) {
        return null;
    }
}

export class VitalsSampler {
    constructor() {
        this._prevCpu = null;
        this._prevNet = null;
        this._thermalInput = this._findThermalInput();
    }

    _findThermalInput() {
        // Prefer zone named with a cpu-ish keyword, fall back to zone0.
        const candidates = [];
        // g_dir_open(path, flags, error): GJS requires the flags argument
        const dir = GLib.Dir.open('/sys/class/thermal', 0);
        let name;
        while ((name = dir.read_name()) !== null) {
            if (!name.startsWith('thermal_zone'))
                continue;
            const type = (readFileString(`/sys/class/thermal/${name}/type`) || '').trim();
            if (/cpu|soc|core|package/i.test(type))
                candidates.unshift(name);
            else
                candidates.push(name);
        }
        dir.close();
        if (!candidates.length)
            return null;
        return `/sys/class/thermal/${candidates[0]}/temp`;
    }

    sample() {
        const result = {
            cpu: null, memUsedPct: null, memUsed: null, memTotal: null,
            netDown: null, netUp: null, temp: null, diskUsedPct: null,
        };

        // CPU load from /proc/stat deltas
        const stat = readFileString('/proc/stat');
        if (stat) {
            const line = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
            const idle = line[3] + (line[4] || 0); // idle + iowait
            const total = line.reduce((a, b) => a + b, 0);
            if (this._prevCpu) {
                const dt = total - this._prevCpu.total;
                const di = idle - this._prevCpu.idle;
                if (dt > 0)
                    result.cpu = Math.max(0, Math.min(100, (1 - di / dt) * 100));
            }
            this._prevCpu = {total, idle};
        }

        // Memory from /proc/meminfo
        const meminfo = readFileString('/proc/meminfo');
        if (meminfo) {
            const get = key => {
                const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
                return m ? parseInt(m[1], 10) : 0;
            };
            const total = get('MemTotal');
            const avail = get('MemAvailable');
            if (total > 0) {
                result.memTotal = total;
                result.memUsed = total - avail;
                result.memUsedPct = (total - avail) / total * 100;
            }
        }

        // Network speed from /proc/net/dev (default route iface)
        const iface = this._defaultInterface();
        if (iface) {
            const netdev = readFileString('/proc/net/dev');
            const m = netdev && netdev.match(new RegExp(`^\\s*${iface}:\\s*(\\d+)\\s.*\\s(\\d+)\\s`, 'm'));
            if (m) {
                const rx = parseInt(m[1], 10);
                const tx = parseInt(m[2], 10);
                const now = GLib.get_monotonic_time() / 1000;
                if (this._prevNet) {
                    const dt = (now - this._prevNet.t) / 1000;
                    if (dt > 0) {
                        result.netDown = (rx - this._prevNet.rx) / dt;
                        result.netUp = (tx - this._prevNet.tx) / dt;
                    }
                }
                this._prevNet = {rx, tx, t: now};
            }
        }

        // Temperature from sysfs (millidegrees)
        if (this._thermalInput) {
            const raw = parseInt(readFileString(this._thermalInput) || '', 10);
            if (!Number.isNaN(raw) && raw > 0)
                result.temp = raw / 1000;
        }

        // Root filesystem usage via Gio filesystem attributes
        try {
            const info = Gio.File.new_for_path('/').query_filesystem_info(
                'filesystem::size,filesystem::used', null);
            const size = info.get_attribute_uint64('filesystem::size');
            const used = info.get_attribute_uint64('filesystem::used');
            if (size > 0)
                result.diskUsedPct = used / size * 100;
        } catch (e) {
            // ignore; some filesystems expose no stats
        }

        return result;
    }

    _defaultInterface() {
        const routes = readFileString('/proc/net/route');
        if (!routes)
            return null;
        for (const line of routes.split('\n').slice(1)) {
            const parts = line.trim().split(/\s+/);
            // Destination == 00000000 means default route
            if (parts.length > 2 && parts[1] === '00000000')
                return parts[0];
        }
        return null;
    }
}

export function formatBytes(bytesPerSec) {
    if (bytesPerSec === null || Number.isNaN(bytesPerSec))
        return '—';
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let v = bytesPerSec;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) {
        v /= 1000;
        i++;
    }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatBytesStatic(kiloBytes) {
    if (kiloBytes === null || Number.isNaN(kiloBytes))
        return '—';
    const units = ['KiB', 'MiB', 'GiB'];
    let v = kiloBytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export class VitalsFeature extends PanelFeature {
    constructor(ctx) {
        super(ctx);
        this._sampler = new VitalsSampler();
        this._timeoutId = 0;
        this._settingsChangedId = 0;
    }

    get id() {
        return 'vitals';
    }

    get settingsKey() {
        return 'enable-vitals';
    }

    panelActors() {
        if (!this._cpuLabel) {
            // Icon + value pairs live in a box so the gsettings switches
            // hide icon and label together.
            this._cpuBox = new St.BoxLayout({style_class: 'gtb-metric', spacing: 4});
            this._cpuIcon = panelIcon('cpu-symbolic');
            this._cpuLabel = new St.Label({style_class: 'gtb-panel-item', y_align: Clutter.ActorAlign.CENTER});
            this._cpuBox.add_child(this._cpuIcon);
            this._cpuBox.add_child(this._cpuLabel);

            this._memBox = new St.BoxLayout({style_class: 'gtb-metric', spacing: 4});
            this._memIcon = panelIcon('memory-symbolic');
            this._memLabel = new St.Label({style_class: 'gtb-panel-item', y_align: Clutter.ActorAlign.CENTER});
            this._memBox.add_child(this._memIcon);
            this._memBox.add_child(this._memLabel);

            this._netLabel = new St.Label({style_class: 'gtb-panel-item', y_align: Clutter.ActorAlign.CENTER});
        }
        return [this._cpuBox, this._memBox, this._netLabel];
    }

    buildMenu(menu) {
        this._vitalsRows = {};
        const section = new PopupMenu.PopupMenuSection();
        const rows = [
            ['cpu', 'CPU'],
            ['mem', '内存'],
            ['temp', '温度'],
            ['disk', '磁盘'],
            ['netDown', '下行网速'],
            ['netUp', '上行网速'],
        ];
        for (const [key, title] of rows) {
            const row = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
            // GNOME 51: St.BoxLayout has no 'expand'; use x_expand
            const box = new St.BoxLayout({x_expand: true});
            const nameLabel = new St.Label({text: title, style_class: 'gtb-row-name'});
            const valueLabel = new St.Label({text: '—', style_class: 'gtb-row-value'});
            valueLabel.x_expand = true;
            valueLabel.x_align = Clutter.ActorAlign.END;
            box.add_child(nameLabel);
            box.add_child(valueLabel);
            row.add_child(box);
            row.label.visible = false;
            this._vitalsRows[key] = valueLabel;
            section.addMenuItem(row);
        }
        menu.addMenuItem(section);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    enable() {
        const settings = this.ctx.settings;
        this._settingsChangedId = settings.connect('changed', (_s, key) =>
            this._onSettingChanged(key));
        this._onSettingChanged(null);
        this._refresh();
        this._startTimer();
    }

    disable() {
        this._stopTimer();
        if (this._settingsChangedId) {
            this.ctx.settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
    }

    _onSettingChanged(key) {
        const s = this.ctx.settings;
        this._cpuBox.visible = s.get_boolean('show-cpu');
        this._memBox.visible = s.get_boolean('show-mem');
        this._netLabel.visible = s.get_boolean('show-net');
        if (key === 'update-interval')
            this._startTimer();
    }

    _startTimer() {
        this._stopTimer();
        const interval = Math.max(1, this.ctx.settings.get_int('update-interval'));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            interval, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _refresh() {
        const v = this._sampler.sample();
        const rows = this._vitalsRows;
        if (v.cpu !== null) {
            this._cpuLabel.set_text(`${Math.round(v.cpu)}%`);
            rows?.cpu.set_text(`${v.cpu.toFixed(1)} %`);
        }
        if (v.memUsedPct !== null) {
            this._memLabel.set_text(`${Math.round(v.memUsedPct)}%`);
            rows?.mem.set_text(
                `${formatBytesStatic(v.memUsed)} / ${formatBytesStatic(v.memTotal)} (${v.memUsedPct.toFixed(0)}%)`);
        }
        if (v.netDown !== null || v.netUp !== null) {
            const d = formatBytes(v.netDown);
            const u = formatBytes(v.netUp);
            this._netLabel.set_text(`↓${d} ↑${u}`);
            rows?.netDown.set_text(d);
            rows?.netUp.set_text(u);
        }
        if (v.temp !== null)
            rows?.temp.set_text(`${v.temp.toFixed(1)} °C`);
        if (v.diskUsedPct !== null)
            rows?.disk.set_text(`${v.diskUsedPct.toFixed(0)} % 已用`);
    }
}
