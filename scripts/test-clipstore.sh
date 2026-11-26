#!/usr/bin/env bash
# Standalone checks for core/clipstore.js — no GNOME Shell needed.
#
# Why the copy step: gjs resolves `import` paths against real file URIs, and a
# directory whose name contains `@` (gnome-toolbox@yibin.github) is parsed as a
# URL with userinfo, so the module URL comes out mangled and import fails with
# "Module not found". `gjs -m -c` is not an option either: `-m` and `-c` are
# mutually exclusive. So the source is staged into a plain temporary directory
# and run from a real .mjs entry point there.
#
# Cases: empty dir, text round-trip, image round-trip (file written + reused),
# eviction prunes the orphan PNG, private mode wins over stale entries,
# corrupted JSON and a deleted image file degrade instead of throwing, and a
# hand-edited digest cannot escape the image directory.
#
# Usage: ./scripts/test-clipstore.sh
# Exit code: 0 when every case passes, 1 otherwise.

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXT="$ROOT/gnome-toolbox@yibin.github"
TMP=$(mktemp -d)

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

command -v gjs >/dev/null || { echo "gjs not found (install gjs)"; exit 1; }

cp "$EXT/core/clipstore.js" "$TMP/clipstore.js"

cat > "$TMP/probe.mjs" <<'EOF'
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ClipboardStore} from './clipstore.js';

const [mode, dir] = ARGV;

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6, 5]);
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const imageEntry = (digest, bytes) => ({
    kind: 'image', bytes, mediaType: 'image/png',
    width: 3072, height: 1920, digest,
});

const imagePath = digest =>
    GLib.build_filenamev([dir, 'images', `${digest}.png`]);

const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);

const mtime = path => {
    const info = Gio.File.new_for_path(path).query_info(
        'time::modified', Gio.FileQueryInfoFlags.NONE, null);
    return info.get_attribute_uint64('time::modified');
};

const bytesEqual = (a, b) => Array.from(a).join(',') === Array.from(b).join(',');

function run() {
    const store = new ClipboardStore({dir});

    switch (mode) {
    case 'empty': {
        const loaded = new ClipboardStore({dir}).load();
        if (loaded.length !== 0)
            return {error: 'empty dir should load as empty'};
        return {};
    }

    case 'roundtrip': {
        store.save([
            {kind: 'text', text: 'hello'},
            imageEntry(DIGEST_A, PNG_A),
        ]);
        store.flush();

        // A fresh instance is what the next shell session sees.
        const entries = new ClipboardStore({dir}).load();
        if (entries.length !== 2)
            return {error: `expected 2 entries, got ${entries.length}`};
        if (entries[0].kind !== 'text' || entries[0].text !== 'hello')
            return {error: `text entry lost: ${JSON.stringify(entries[0])}`};
        if (entries[1].kind !== 'image')
            return {error: 'image entry lost'};
        if (entries[1].width !== 3072 || entries[1].height !== 1920)
            return {error: `image size lost: ${entries[1].width}x${entries[1].height}`};
        if (!bytesEqual(entries[1].bytes, PNG_A))
            return {error: 'image bytes changed'};
        if (!exists(imagePath(DIGEST_A)))
            return {error: 'image file missing'};
        return {};
    }

    case 'image-reuse': {
        // Same digest twice: the second save must not rewrite the file (mtime
        // is the observable), which is what keeps copy bursts cheap.
        store.save([imageEntry(DIGEST_A, PNG_A)]);
        store.flush();
        if (!exists(imagePath(DIGEST_A)))
            return {error: 'image file not written'};
        const before = mtime(imagePath(DIGEST_A));

        // One-second granularity on some filesystems: sleep past it so a
        // rewrite would actually show up.
        GLib.usleep(1_100_000);
        store.save([imageEntry(DIGEST_B, PNG_B), imageEntry(DIGEST_A, PNG_A)]);
        store.flush();
        if (mtime(imagePath(DIGEST_A)) !== before)
            return {error: 'unchanged image was rewritten'};
        if (!exists(imagePath(DIGEST_B)))
            return {error: 'second image missing'};
        return {};
    }

    case 'prune': {
        store.save([imageEntry(DIGEST_A, PNG_A), imageEntry(DIGEST_B, PNG_B)]);
        store.flush();
        if (!exists(imagePath(DIGEST_B)))
            return {error: 'image B missing before prune'};

        // Drop B from the history: its PNG must not outlive it on disk.
        store.save([imageEntry(DIGEST_A, PNG_A)]);
        store.flush();
        if (exists(imagePath(DIGEST_B)))
            return {error: 'orphan image was not pruned'};
        if (!exists(imagePath(DIGEST_A)))
            return {error: 'live image was pruned'};
        return {};
    }

    case 'private': {
        store.save([{kind: 'text', text: 'secret'}]);
        store.flush();

        // Entering privacy mode wipes the snapshot outright, so the next
        // session starts empty instead of resurrecting what was copied before.
        store.clear();
        const next = new ClipboardStore({dir}).load();
        if (next.length)
            return {error: 'entries survived privacy mode'};
        return {};
    }

    case 'corrupt': {
        store.save([{kind: 'text', text: 'x'}]);
        store.flush();
        GLib.file_set_contents(store.path, '{"version": 1, "entries": [');

        const loaded = new ClipboardStore({dir}).load();
        if (loaded.length !== 0)
            return {error: 'corrupt snapshot produced entries'};
        return {};
    }

    case 'missing-image': {
        store.save([{kind: 'text', text: 'keep'}, imageEntry(DIGEST_A, PNG_A)]);
        store.flush();
        GLib.unlink(imagePath(DIGEST_A));

        const loaded = new ClipboardStore({dir}).load();
        if (loaded.length !== 1 || loaded[0].kind !== 'text')
            return {error: `missing image should drop only that entry: ${loaded.length}`};
        return {};
    }

    case 'bad-digest': {
        // Hand-edited snapshot trying to escape the image directory.
        GLib.mkdir_with_parents(GLib.build_filenamev([dir, 'images']), 0o700);
        GLib.file_set_contents(store.path, JSON.stringify({
            version: 1,
            privateMode: false,
            entries: [
                {kind: 'image', digest: '../../etc/passwd', width: 1, height: 1},
                {kind: 'image', digest: 'not-a-digest', width: 1, height: 1},
            ],
        }));
        const loaded = new ClipboardStore({dir}).load();
        if (loaded.length !== 0)
            return {error: 'unsafe digest was accepted'};
        return {};
    }

    case 'debounce': {
        // save() is coalesced; a destroy() without flush() must not leave a
        // timer behind that touches a half-destroyed store.
        store.save([{kind: 'text', text: 'pending'}]);
        store.destroy();
        if (GLib.file_test(store.path, GLib.FileTest.EXISTS))
            return {error: 'destroy() wrote the queued snapshot'};
        return {};
    }

    default:
        return {error: `unknown mode ${mode}`};
    }
}

const {error} = run();
print(error ? JSON.stringify({ok: false, error}) : JSON.stringify({ok: true}));
EOF

FAILED=0
check() {
    local name=$1
    local out
    out=$(gjs -m "$TMP/probe.mjs" "$name" "$TMP/state" 2>&1 | tail -1)
    case "$out" in
    '{"ok":true}'*)
        echo "ok   $name"
        ;;
    *)
        echo "FAIL $name: $out"
        FAILED=1
        ;;
    esac
    rm -rf "$TMP/state"
}

check empty
check roundtrip
check image-reuse
check prune
check private
check corrupt
check missing-image
check bad-digest
check debounce

exit "$FAILED"
