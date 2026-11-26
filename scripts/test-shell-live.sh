#!/usr/bin/env bash
# End-to-end checks in a throwaway headless GNOME Shell — the only way to see
# the two defects this covers, because both live inside a running shell:
#
#   1. clipboard history surviving a shell restart
#      (ClipboardStore → ClipboardManager.restore() → menu rows)
#   2. the shared dropdown staying inside the screen and scrollable
#      (MenuScroll wrapping the popup content)
#
# The real extension is installed next to a tiny probe extension that measures
# the live indicator and prints one PROBE line. The shell runs headless on a
# private session bus with private XDG dirs, so nothing touches the user's
# session, clipboard or extension state.
#
# Two shell runs: the first pushes text through ClipboardManager (which writes
# the snapshot), the second asserts the same text is back in the history right
# after boot — that is the "history is gone after a reboot" regression.
#
# Usage: ./scripts/test-shell-live.sh
# Exit code: 0 when every assertion passes, 1 otherwise.

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXT="$ROOT/gnome-toolbox@yibin.github"
UUID="gnome-toolbox@yibin.github"
PROBE_UUID="gtb-probe@yibin.test"
WORK=$(mktemp -d)
RUN_TIMEOUT=${RUN_TIMEOUT:-60}

cleanup() { rm -rf "$WORK" 2>/dev/null; }
trap cleanup EXIT

command -v gnome-shell >/dev/null || { echo "gnome-shell not found"; exit 1; }
command -v dbus-run-session >/dev/null || { echo "dbus-run-session not found"; exit 1; }

# Isolated session: nothing below reaches the real user profile.
export XDG_DATA_HOME="$WORK/data"
export XDG_CONFIG_HOME="$WORK/config"
export XDG_CACHE_HOME="$WORK/cache"
export XDG_STATE_HOME="$WORK/state"
export XDG_RUNTIME_DIR="$WORK/run"
mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions" "$XDG_CONFIG_HOME" \
    "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

cp -r "$EXT" "$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
PROBE_DIR="$XDG_DATA_HOME/gnome-shell/extensions/$PROBE_UUID"
mkdir -p "$PROBE_DIR"

cat > "$PROBE_DIR/metadata.json" <<EOF
{
  "uuid": "$PROBE_UUID",
  "name": "Toolbox live probe",
  "description": "Measures the toolbox dropdown; test fixture only.",
  "shell-version": ["51"]
}
EOF

# The probe: waits for the toolbox indicator, then either seeds the history or
# asserts the restored history and the menu clamp. One PROBE line per run.
cat > "$PROBE_DIR/extension.js" <<'EOF'
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const SEED_TEXTS = ['persist-alpha', 'persist-beta'];

// Real PNG bytes handed in by the harness (see PNG_B64 in the shell script),
// so the store and the thumbnail rebuild both run on genuine image data.
const PNG = GLib.base64_decode(GLib.getenv('GTB_PROBE_PNG') ?? '');

function log(line) {
    // print() goes to the shell's stdout, which the test captures.
    print(`PROBE ${line}`);
}

export default class ProbeExtension {
    enable() {
        // Let the toolbox finish enable() and the panel settle.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            try {
                this._run();
            } catch (e) {
                log(`FAIL exception ${e.message} | ${e.stack}`.replaceAll('\n', ' '));
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {}

    _run() {
        const mode = GLib.getenv('GTB_PROBE_MODE') ?? 'verify';
        const ind = Main.panel.statusArea['gnome-toolbox'];
        if (!ind) {
            log('FAIL indicator missing');
            return;
        }
        const manager = ind._extension?._clipboardManager;
        if (!manager) {
            log('FAIL clipboard manager missing');
            return;
        }

        if (mode === 'seed') {
            for (const text of SEED_TEXTS)
                manager._pushText(text);

            // A real PNG goes through the same store path as a screenshot, so
            // the image file + digest round-trip is covered too.
            const png = PNG;
            const digest = manager._digest(png);
            manager._pushEntry({
                kind: 'image',
                bytes: png,
                mediaType: 'image/png',
                width: 4,
                height: 4,
                thumb: null,
                digest,
            });

            // The write is debounced; flush so the snapshot exists before this
            // shell is killed (a killed shell never runs the pending write).
            manager._store.flush();
            log(`SEEDED count=${manager.history.length} digest=${digest}`);
            return;
        }

        if (mode === 'trim') {
            // Shrinking history-size must prune the snapshot too, otherwise the
            // evicted entries reappear on the next login.
            for (let i = 0; i < 6; i++)
                manager._pushText(`trim-${i}`);
            ind._extension._settings.set_int('history-size', 2);
            manager._store.flush();

            const stored = manager._store.load();
            const trimmed = manager.history.length;
            const persisted = stored.length;

            // Leave the fixture as it was found: the setting lives in dconf,
            // which the later runs share.
            ind._extension._settings.set_int('history-size', 15);
            manager._store.flush();

            if (trimmed !== 2)
                log(`FAIL in-memory history not trimmed: ${trimmed}`);
            else if (persisted !== 2)
                log(`FAIL snapshot still holds ${persisted} entries`);
            else
                log('TRIM_OK');
            return;
        }

        if (mode === 'privacy') {
            // Privacy mode is a session switch: turning it on must wipe what is
            // already on disk, and a copy made afterwards must not be written.
            for (const text of SEED_TEXTS)
                manager._pushText(text);
            manager.setPrivateMode(true);

            const afterMode = manager._store.load();
            if (afterMode.length)
                log(`FAIL privacy did not wipe the snapshot: ${afterMode.length} entries`);
            else if (manager.history.length)
                log(`FAIL privacy left ${manager.history.length} in-memory entries`);
            else
                log('PRIVACY_OK');
            return;
        }

        const problems = [];

        // --- 1. history came back from disk -------------------------------
        const texts = manager.history
            .filter(e => e.kind === 'text')
            .map(e => e.text);
        if (!SEED_TEXTS.every(t => texts.includes(t)))
            problems.push(`history not restored: ${JSON.stringify(texts)}`);

        const image = manager.history.find(e => e.kind === 'image');
        if (!image)
            problems.push('image entry not restored');
        else {
            if (!image.bytes?.length)
                problems.push('restored image has no bytes');
            if (image.width !== 4 || image.height !== 4)
                problems.push(`restored image size lost: ${image.width}x${image.height}`);
            if (!image.thumb)
                problems.push('restored image has no thumbnail');
        }

        // --- 2. the menu is clamped and scrollable ------------------------
        const scroll = ind._menuScroll?.scrollView;
        if (!scroll) {
            problems.push('no viewport installed');
        } else {
            if (ind.menu.box.get_parent() !== scroll)
                problems.push('menu box not inside the viewport');

            // Overflow the menu the way clipboard history + tray rows do.
            for (let i = 0; i < 60; i++)
                ind.menu.addMenuItem(new PopupMenu.PopupMenuItem(`filler ${i}`));

            ind.menu.open();

            // Allocation only happens on the frame after the popup is mapped,
            // so the measurements are taken from a follow-up timeout instead of
            // inline.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                try {
                    this._measure(ind, scroll, problems);
                } catch (e) {
                    problems.push(`measure failed: ${e.message}`);
                }
                log(problems.length ? `FAIL ${JSON.stringify(problems)}` : 'OK');
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        log(problems.length ? `FAIL ${JSON.stringify(problems)}` : 'OK');
    }

    _measure(ind, scroll, problems) {
        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            Main.layoutManager.findIndexForActor(ind));
        // get_preferred_size() is [minWidth, minHeight, naturalWidth,
        // naturalHeight] — minHeight must be 0 for a clamped viewport, which
        // is what lets the popup shrink below its content.
        const [minW, minH, natW, natH] = scroll.get_preferred_size();
        log(`MENU min=${minW}x${minH} natural=${natW}x${natH} workArea=${workArea.width}x${workArea.height} style=${scroll.style}`);
        // The only minimum the viewport may report is its own theme chrome
        // (`.popup-menu-content` padding + border = 14px here). A minimum near
        // the natural height would mean the viewport refuses to shrink and the
        // clamp would do nothing.
        if (minH > 40)
            problems.push(`viewport min height ${minH} blocks shrinking`);

        const match = scroll.style.match(/max-height:\s*(\d+)px/);
        if (!match)
            problems.push(`viewport not clamped: '${scroll.style}'`);
        const limit = Number(match?.[1] ?? 0);
        if (limit > 0 && limit > workArea.height)
            problems.push(`clamp ${limit} exceeds work area ${workArea.height}`);

        // Wheel events are what users actually try first: St.ScrollView only
        // handles them while it is reactive with mouse scrolling on.
        if (!scroll.reactive || !scroll.enable_mouse_scrolling)
            problems.push(`viewport ignores wheel events: reactive=${scroll.reactive} mouse=${scroll.enable_mouse_scrolling}`);

        const adjustment = scroll.vadjustment;
        const [, , upper, , , pageSize] = adjustment.get_values();
        if (upper <= pageSize)
            problems.push(`nothing to scroll: upper=${upper} page=${pageSize}`);
        adjustment.set_value(80);
        if (adjustment.get_value() !== 80)
            problems.push('adjustment refused to scroll');

        // Every row must be reachable: scrolling to the end has to bring the
        // last row's bottom inside the page. This is the actual user-visible
        // complaint ("content below cannot be scrolled into view").
        adjustment.set_value(upper);
        const rows = ind.menu._getMenuItems();
        const last = rows[rows.length - 1]?.actor;
        if (!last) {
            problems.push('menu has no items');
        } else {
            // Row position in the *scrolled* coordinate space: relative to the
            // menu box (the viewport's child), which is what the adjustment
            // moves. Adding the viewport's own padding would offset it.
            const content = scroll.get_child();
            const box = last.get_allocation_box();
            let y1 = box.y1;
            let y2 = box.y2;
            for (let parent = last.get_parent(); parent && parent !== content;
                parent = parent.get_parent()) {
                y1 += parent.get_allocation_box().y1;
                y2 += parent.get_allocation_box().y1;
            }
            const visibleTop = adjustment.get_value();
            const visibleBottom = visibleTop + pageSize;
            log(`SCROLL value=${visibleTop} upper=${upper} page=${pageSize} lastRow=${Math.round(y1)}..${Math.round(y2)}`);
            if (y1 < visibleTop || y1 > visibleBottom)
                problems.push(`last row not in view at the bottom: row=${Math.round(y1)} visible=${Math.round(visibleTop)}..${Math.round(visibleBottom)}`);
            if (y2 > upper + 2)
                problems.push(`content taller than the scrollable extent: rowBottom=${Math.round(y2)} upper=${Math.round(upper)}`);
        }

        // Keyboard focus must scroll the focused row into view as well, since
        // the viewport does not follow focus on its own.
        adjustment.set_value(0);
        const firstRow = rows[0];
        ind.menu._activeMenuItem = null;
        ind.menu.emit('active-changed', firstRow);
        if (adjustment.get_value() !== 0)
            problems.push(`focus on the first row scrolled to ${adjustment.get_value()}`);
        adjustment.set_value(upper);
        ind.menu.emit('active-changed', rows[rows.length - 2]);

        // Hot toggling a feature rebuilds the whole menu (menu.removeAll() +
        // every feature's buildMenu), which must not disturb the viewport or
        // leave the history unreachable.
        const settings = ind._extension?._settings;
        if (settings) {
            settings.set_boolean('enable-clipboard', false);
            settings.set_boolean('enable-clipboard', true);
            if (ind.menu.box.get_parent() !== scroll)
                problems.push('rebuild detached the viewport');
            const textsAfter = ind._extension._clipboardManager.history
                .filter(e => e.kind === 'text')
                .map(e => e.text);
            if (!SEED_TEXTS.every(t => textsAfter.includes(t)))
                problems.push(`rebuild lost the history: ${JSON.stringify(textsAfter)}`);

            // The rebuilt menu still has to render the restored rows.
            ind.menu.close();
            ind.menu.open();
        }

        const [, , w, h] = ind.menu.actor.get_preferred_size();
        const [x, y] = ind.menu.actor.get_transformed_position();
        log(`POPUP size=${w}x${h} at=${x},${y} bottom=${Math.round(y + h)} workAreaBottom=${workArea.y + workArea.height}`);
        if (limit > 0 && y + h > workArea.y + workArea.height + 2)
            problems.push(`popup overflows: bottom=${Math.round(y + h)} workAreaBottom=${workArea.y + workArea.height}`);

        ind.menu.close();

        // --- 3. extension disable -> enable --------------------------------
        // A full cycle destroys the indicator (MenuScroll.destroy() unwraps the
        // viewport) and builds a new one, plus a new ClipboardManager that has
        // to restore from disk again. Both are where a leak or a half-torn
        // down actor tree would show up.
        const extension = ind._extension;
        extension.disable();
        extension.enable();

        const rebuilt = Main.panel.statusArea['gnome-toolbox'];
        if (!rebuilt)
            problems.push('indicator missing after re-enable');
        else {
            const newScroll = rebuilt._menuScroll?.scrollView;
            if (!newScroll)
                problems.push('no viewport after re-enable');
            if (newScroll && rebuilt.menu.box.get_parent() !== newScroll)
                problems.push('menu box not in the viewport after re-enable');

            const history = rebuilt._extension?._clipboardManager?.history ?? [];
            const texts = history.filter(e => e.kind === 'text').map(e => e.text);
            if (!SEED_TEXTS.every(t => texts.includes(t)))
                problems.push(`re-enable lost the history: ${JSON.stringify(texts)}`);
            if (!history.some(e => e.kind === 'image'))
                problems.push('re-enable lost the image entry');
        }
    }
}
EOF

# Both extensions must be enabled in the shell's gsettings; dconf stores the
# value under XDG_CONFIG_HOME, so the shell runs below pick it up.
dbus-run-session -- gsettings set org.gnome.shell enabled-extensions \
    "['$PROBE_UUID', '$UUID']" >/dev/null 2>&1
dbus-run-session -- gsettings set org.gnome.shell disable-extension-version-validation true \
    >/dev/null 2>&1

# A genuine 4x4 PNG for the image round-trip (pure python, no image tools).
PNG_B64=$(python3 - <<'PY_PNG'
import base64, struct, zlib

w = h = 4
raw = b''.join(b'\x00' + bytes([200, 100, 50, 255]) * w for _ in range(h))

def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data +
            struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

png = (b'\x89PNG\r\n\x1a\n' +
       chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) +
       chunk(b'IDAT', zlib.compress(raw)) +
       chunk(b'IEND', b''))
print(base64.b64encode(png).decode())
PY_PNG
)
[ -n "$PNG_B64" ] || { echo "could not build the test PNG"; exit 1; }
export GTB_PROBE_PNG="$PNG_B64"

FAILED=0

fail_check() {
    echo "FAIL $1: $2"
    FAILED=1
}

# our_js_errors LOGFILE — print the JS errors that belong to this extension.
# A headless shell also logs unrelated shell-internal failures (calendar.js
# races on the session bus, for one), and those must not fail the suite.
our_js_errors() {
    grep -A6 'JS ERROR' "$1" 2>/dev/null |
        grep -E 'gnome-toolbox|gtb-probe|clipstore|menuscroll|clipboard\.js|indicator\.js'
}

# run_shell MODE LOGFILE MARKER — boots a headless shell (own process group),
# waits until the probe prints MARKER or until RUN_TIMEOUT, then tears the whole
# group down. The teardown is not cosmetic: dbus-run-session forks gnome-shell
# away from itself, so killing only the wrapper leaves an orphan shell holding
# the private XDG_RUNTIME_DIR, and the next run then talks to the *old* shell
# (its stale dconf/dbus state) instead of a fresh one.
run_shell() {
    local mode=$1 logfile=$2 marker=$3 pid deadline
    setsid dbus-run-session -- env GTB_PROBE_MODE="$mode" \
        gnome-shell --headless --virtual-monitor 1280x800 > "$logfile" 2>&1 &
    pid=$!
    deadline=$((SECONDS + RUN_TIMEOUT))
    while [ "$SECONDS" -lt "$deadline" ]; do
        grep -q "$marker" "$logfile" 2>/dev/null && break
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    kill -TERM -"$pid" 2>/dev/null
    # Give the shell a moment to exit on SIGTERM before it is forced.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 -"$pid" 2>/dev/null || break
        sleep 0.3
    done
    kill -KILL -"$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    return 0
}

# --- run 1: seed the snapshot ---------------------------------------------
LOG1="$WORK/run1.log"
run_shell seed "$LOG1" "PROBE SEEDED"
if ! grep -q "PROBE SEEDED" "$LOG1"; then
    fail_check "seed run" \
        "$(grep -E 'PROBE|JS ERROR|Extension .* had error' "$LOG1" | head -6 | tr '\n' ' ')"
fi
our_js_errors "$LOG1" && fail_check "seed run JS" "$(our_js_errors "$LOG1" | head -4 | tr '\n' ' ')"

SNAPSHOT="$XDG_STATE_HOME/gnome-toolbox/clipboard/history.json"
if [ ! -f "$SNAPSHOT" ]; then
    fail_check "snapshot" "history.json not written at $SNAPSHOT"
else
    grep -q 'persist-alpha' "$SNAPSHOT" || fail_check "snapshot" \
        "seeded text missing from the snapshot"
fi

# --- run 1b: privacy mode wipes the saved snapshot ------------------------
LOG1B="$WORK/run1b.log"
run_shell privacy "$LOG1B" "PROBE PRIVACY_OK"
if grep -q "PROBE PRIVACY_OK" "$LOG1B"; then
    echo "ok   live shell: privacy mode wipes the saved snapshot"
else
    fail_check "privacy run" \
        "$(grep -E 'PROBE|JS ERROR' "$LOG1B" | head -4 | tr '\n' ' ')"
fi

# --- run 1c: shrinking the history prunes the snapshot --------------------
LOG1C="$WORK/run1c.log"
run_shell trim "$LOG1C" "PROBE TRIM_OK"
if grep -q "PROBE TRIM_OK" "$LOG1C"; then
    echo "ok   live shell: trimming history shrinks the snapshot"
else
    fail_check "trim run" \
        "$(grep -E 'PROBE|JS ERROR' "$LOG1C" | head -4 | tr '\n' ' ')"
fi

# Re-seed: the runs above deliberately rewrote the snapshot.
run_shell seed "$LOG1" "PROBE SEEDED"

# --- run 2: a fresh shell must restore it ---------------------------------
LOG2="$WORK/run2.log"
run_shell verify "$LOG2" "PROBE OK"
grep -E "PROBE (MENU|POPUP|SCROLL)" "$LOG2" | sed 's/^/     /'
if grep -q "PROBE OK" "$LOG2"; then
    echo "ok   live shell: history restored + menu clamped and scrollable"
else
    fail_check "verify run" \
        "$(grep -E 'PROBE (FAIL|MENU|POPUP|SCROLL)|JS ERROR|Extension .* had error' "$LOG2" | head -8 | tr '\n' ' ')"
fi

exit "$FAILED"
