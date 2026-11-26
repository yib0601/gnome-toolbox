// ClipboardStore: durable on-disk snapshot of the clipboard history.
//
// The history itself lives in the gnome-shell process, so a logout or reboot
// used to wipe it. This module owns the only thing the shell cannot keep in
// RAM: a JSON envelope plus one PNG file per image entry, written atomically
// under the user state directory.
//
// Responsibility: serialise/deserialise the snapshot and manage its image
// files. It does NOT capture the clipboard, dedup entries, build thumbnails,
// or touch any UI — those stay in features/clipboard.js, which hands over a
// plain array of entries.
//
// Layout (~/.local/state/gnome-toolbox/clipboard):
//   history.json          {version, entries: [...]}
//   images/<sha256>.png   image bytes, content addressed by the entry digest
//
// Privacy mode is deliberately NOT part of the snapshot: it means "do not keep
// what I copy now", which is a session switch, not a stored preference. Turning
// it on wipes the snapshot; that is the whole durable effect.
//
// Text stays inline (cheap, and a text history is the common case); images go
// to separate files because base64 in JSON would triple a 5 MB screenshot and
// rewrite every image on every save.
//
// Shell-independent on purpose: exercised by scripts/test-clipstore.sh.

import GLib from 'gi://GLib';

// Bump when the envelope shape changes; unknown versions load as empty rather
// than as half-parsed garbage.
const FORMAT_VERSION = 1;

const SNAPSHOT_NAME = 'history.json';
const IMAGE_DIR = 'images';

// Copies arrive in bursts (an app may churn ownership several times), so the
// write is coalesced. Explicit actions (clear, privacy, feature destroy)
// flush immediately instead of waiting for it.
const SAVE_DEBOUNCE_MS = 1500;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Digest shape accepted from disk: sha256 hex. Anything else (path traversal,
// hand-edited junk) is rejected before it reaches a file name.
const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * @param {*} value raw JSON field
 * @returns {number} non-negative pixel dimension, or 0 when unusable
 */
function dimension(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.round(value)
        : 0;
}

export class ClipboardStore {
    /**
     * @param {object} [options]
     * @param {string|null} [options.dir] override the state directory (tests)
     * @param {{warn: Function}|null} [options.log] logger, e.g. core/logger
     */
    constructor({dir = null, log = null} = {}) {
        this._dir = dir ?? GLib.build_filenamev([
            GLib.get_user_state_dir(), 'gnome-toolbox', 'clipboard',
        ]);
        this._log = log;
        // Debounce state: pending snapshot + its timeout source.
        this._pending = null;
        this._pendingId = 0;
        // Last bytes written, so an unchanged snapshot does not rewrite the file.
        this._lastWritten = null;
    }

    get path() {
        return GLib.build_filenamev([this._dir, SNAPSHOT_NAME]);
    }

    get imageDir() {
        return GLib.build_filenamev([this._dir, IMAGE_DIR]);
    }

    /**
     * Read the snapshot back.
     * @returns {Array<object>} entries as `{kind:'text', text}` or
     *   `{kind:'image', bytes, mediaType, width, height, digest}`; images whose
     *   file is gone or unreadable are dropped instead of failing the load.
     */
    load() {
        let raw;
        try {
            const [ok, contents] = GLib.file_get_contents(this.path);
            if (!ok)
                return [];
            raw = new TextDecoder().decode(contents);
        } catch (e) {
            // ENOENT on the first run after install/upgrade: not an error.
            return [];
        }

        let doc;
        try {
            doc = JSON.parse(raw);
        } catch (e) {
            this._log?.warn(`gnome-toolbox: clipboard snapshot unreadable, dropping it: ${e.message}`);
            return [];
        }

        if (!doc || doc.version !== FORMAT_VERSION || !Array.isArray(doc.entries))
            return [];

        const entries = [];
        for (const item of doc.entries) {
            const entry = this._readEntry(item);
            if (entry)
                entries.push(entry);
        }
        return entries;
    }

    /**
     * Queue a snapshot for writing. Coalesced; call flush() to write at once.
     * @param {Array<object>} entries history entries in display order
     */
    save(entries) {
        this._pending = Array.isArray(entries) ? entries.slice() : [];

        if (this._pendingId)
            return;
        this._pendingId = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DEBOUNCE_MS, () => {
            this._pendingId = 0;
            this._writePending();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Write the queued snapshot now (no-op when nothing is queued).
     */
    flush() {
        if (this._pendingId) {
            GLib.source_remove(this._pendingId);
            this._pendingId = 0;
        }
        this._writePending();
    }

    /**
     * Drop every persisted entry (and its image files) right away. Used by
     * "清空历史", by enabling privacy mode and by turning persistence off.
     */
    clear() {
        this._pending = null;
        if (this._pendingId) {
            GLib.source_remove(this._pendingId);
            this._pendingId = 0;
        }
        // Never persisted anything: nothing to delete, and creating an empty
        // directory here would only make the "no history stored" state harder
        // to read from the filesystem.
        if (!GLib.file_test(this.path, GLib.FileTest.EXISTS) &&
            !GLib.file_test(this.imageDir, GLib.FileTest.IS_DIR))
            return;
        this._write([]);
    }

    /**
     * Stop the debounce timer without writing. The caller decides whether the
     * queued snapshot still matters (features/clipboard.js flushes first).
     */
    destroy() {
        if (this._pendingId) {
            GLib.source_remove(this._pendingId);
            this._pendingId = 0;
        }
        this._pending = null;
    }

    // --- internals ---------------------------------------------------------

    _writePending() {
        const entries = this._pending;
        this._pending = null;
        if (!entries)
            return;
        this._write(entries);
    }

    _write(entries) {
        if (!this._ensureDirs())
            return;

        const stored = [];
        const keep = new Set();
        for (const entry of entries) {
            if (entry?.kind === 'text') {
                if (typeof entry.text === 'string' && entry.text)
                    stored.push({kind: 'text', text: entry.text});
                continue;
            }
            if (entry?.kind !== 'image' || !entry.digest || !entry.bytes?.length ||
                !DIGEST_RE.test(entry.digest))
                continue;
            if (!this._writeImage(entry.digest, entry.bytes))
                continue;
            keep.add(`${entry.digest}.png`);
            stored.push({
                kind: 'image',
                digest: entry.digest,
                width: dimension(entry.width),
                height: dimension(entry.height),
            });
        }

        const doc = JSON.stringify({version: FORMAT_VERSION, entries: stored});

        // An unchanged snapshot is the common case (same row re-selected,
        // dedup refresh): skip the fsync.
        if (doc !== this._lastWritten) {
            try {
                const ok = GLib.file_set_contents_full(this.path, doc,
                    GLib.FileSetContentsFlags.CONSISTENT |
                    GLib.FileSetContentsFlags.DURABLE, FILE_MODE);
                if (!ok) {
                    this._log?.warn('gnome-toolbox: clipboard snapshot write failed');
                    return;
                }
                this._lastWritten = doc;
            } catch (e) {
                this._log?.warn(`gnome-toolbox: clipboard snapshot write failed: ${e.message}`);
                return;
            }
        }

        // Entries evicted from the history (or dropped on load because their
        // file was corrupt) leave their PNG behind otherwise.
        this._pruneImages(keep);
    }

    _readEntry(item) {
        if (!item || typeof item !== 'object')
            return null;

        if (item.kind === 'text')
            return typeof item.text === 'string' && item.text
                ? {kind: 'text', text: item.text}
                : null;

        if (item.kind !== 'image' || typeof item.digest !== 'string' ||
            !DIGEST_RE.test(item.digest))
            return null;

        const bytes = this._readImage(item.digest);
        if (!bytes)
            return null;

        return {
            kind: 'image',
            bytes,
            mediaType: 'image/png',
            width: dimension(item.width),
            height: dimension(item.height),
            digest: item.digest,
        };
    }

    _ensureDirs() {
        try {
            if (GLib.mkdir_with_parents(this._dir, DIR_MODE) !== 0)
                return false;
            if (GLib.mkdir_with_parents(this.imageDir, DIR_MODE) !== 0)
                return false;
        } catch (e) {
            this._log?.warn(`gnome-toolbox: clipboard store dir failed: ${e.message}`);
            return false;
        }
        return true;
    }

    _imagePath(digest) {
        return GLib.build_filenamev([this.imageDir, `${digest}.png`]);
    }

    _writeImage(digest, bytes) {
        const path = this._imagePath(digest);
        // Content addressed: an existing file already holds exactly these
        // bytes, so a repeated copy must not rewrite a multi-megabyte PNG.
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return true;
        try {
            const ok = GLib.file_set_contents_full(path, bytes,
                GLib.FileSetContentsFlags.CONSISTENT |
                GLib.FileSetContentsFlags.DURABLE, FILE_MODE);
            if (!ok)
                this._log?.warn(`gnome-toolbox: clipboard image write failed (${digest})`);
            return ok;
        } catch (e) {
            this._log?.warn(`gnome-toolbox: clipboard image write failed: ${e.message}`);
            return false;
        }
    }

    _readImage(digest) {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._imagePath(digest));
            return ok && bytes?.length ? bytes : null;
        } catch (e) {
            return null;
        }
    }

    _pruneImages(keep) {
        let dir;
        try {
            dir = GLib.Dir.open(this.imageDir, 0);
        } catch (e) {
            // No image directory yet: nothing to prune.
            return;
        }

        try {
            let name;
            while ((name = dir.read_name()) !== null) {
                if (!name.endsWith('.png') || keep.has(name))
                    continue;
                try {
                    GLib.unlink(GLib.build_filenamev([this.imageDir, name]));
                } catch (e) {
                    this._log?.warn(`gnome-toolbox: clipboard image cleanup failed: ${e.message}`);
                }
            }
        } finally {
            dir.close();
        }
    }
}
