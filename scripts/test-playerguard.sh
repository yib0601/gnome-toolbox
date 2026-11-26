#!/usr/bin/env bash
# Standalone checks for core/playerguard.js against throwaway D-Bus fixtures —
# no GNOME Shell needed.
#
# Why the copy step: gjs resolves `import` paths against real file URIs, and a
# directory whose name contains `@` (gnome-toolbox@yibin.github) is parsed as a
# URL with userinfo, so the module URL comes out mangled and import fails with
# "Module not found". `gjs -m -c` is not an option either: `-m` and `-c` are
# mutually exclusive and gjs answers "Failed to parse module <command line>".
# So the sources are staged into a plain temporary directory and run from a
# real .mjs entry point there.
#
# Cases: absent / healthy / hung. The hung case fails by design until the
# liveness check stops relying on org.freedesktop.DBus.Peer.Ping — GLib answers
# that method for a connection from the calling thread of the message bus, so a
# wedged process still pings OK (see the report at the end of the run).
#
# Usage: ./scripts/test-playerguard.sh [DBUS_NAME]
# Exit code: 0 when every case behaves as documented, 1 otherwise.

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXT="$ROOT/gnome-toolbox@yibin.github"
BUS=${1:-org.gnome.Showtime}

command -v gjs >/dev/null || { echo "gjs not found (install gjs)"; exit 1; }

TMP=$(mktemp -d)
PIDS=()
cleanup() {
    for pid in "${PIDS[@]}"; do kill -9 "$pid" 2>/dev/null; done
    wait 2>/dev/null
    rm -rf "$TMP"
}
trap cleanup EXIT

cp "$EXT/core/playerguard.js" "$TMP/playerguard.js"

# Entry point: one probe against $BUS, result printed as JSON.
cat > "$TMP/probe.mjs" <<EOF
import {PlayerGuard} from './playerguard.js';

const [name, timeoutMs] = ARGV;
const result = await new PlayerGuard(name).probe(Number(timeoutMs));
print(JSON.stringify(result));
if (typeof result?.state !== 'string')
    throw new Error('probe() returned no state');
EOF

# Fixture: takes $BUS, then either runs a main loop (`responsive`) or blocks the
# loop with usleep (`frozen`) — what a deadlocked Showtime looks like outside.
cat > "$TMP/fixture.mjs" <<EOF
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [name, mode] = ARGV;
const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
Gio.bus_own_name_on_connection(bus, name, Gio.BusNameOwnerFlags.NONE, null, null);
print('ready');

if (mode === 'frozen') {
    GLib.usleep(600 * 1000 * 1000);
} else {
    new GLib.MainLoop(null, false).run();
}
EOF

start_fixture() {
    gjs -m "$TMP/fixture.mjs" "$BUS" "$1" > "$TMP/fixture.log" 2>&1 &
    PIDS+=("$!")
    for _ in $(seq 50); do
        grep -q ready "$TMP/fixture.log" 2>/dev/null && return 0
        sleep 0.1
    done
    echo "fixture ($1) never claimed $BUS"; cat "$TMP/fixture.log"; return 1
}

stop_fixtures() {
    for pid in "${PIDS[@]}"; do kill -9 "$pid" 2>/dev/null; done
    PIDS=()
    wait 2>/dev/null
    # Wait for the bus itself to drop the name.
    for _ in $(seq 50); do
        gdbus call --session --dest org.freedesktop.DBus \
            --object-path /org/freedesktop/DBus \
            --method org.freedesktop.DBus.GetNameOwner "$BUS" >/dev/null 2>&1 || return 0
        sleep 0.1
    done
    echo "warn: $BUS is still owned"
    return 1
}

state_of() {
    gjs -m "$TMP/probe.mjs" "$BUS" "$1" 2>/dev/null | tail -1 |
        sed -n 's/.*"state":"\([a-z]*\)".*/\1/p'
}

FAILED=0
check() {
    if [ "$2" = "$3" ]; then
        echo "ok   $1: $3"
    else
        echo "FAIL $1: expected $2, got $3"
        FAILED=1
    fi
}

stop_fixtures
check absent absent "$(state_of 1500)"

start_fixture responsive || exit 1
check healthy healthy "$(state_of 1500)"
stop_fixtures

start_fixture frozen || exit 1
check hung hung "$(state_of 1000)"
stop_fixtures

exit "$FAILED"
