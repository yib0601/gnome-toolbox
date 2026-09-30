// System vitals monitor: CPU / memory / disk / network / temperature.
// Data sources: /proc/stat, /proc/meminfo, /proc/net/dev, sysfs thermal.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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
