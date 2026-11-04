// Clipboard feature: history with dedup, privacy mode, set/paste, plus
// in-place normalization of mislabelled screenshot bytes.
// Listens to Meta selection owner changes and St.Clipboard.
//
// History holds two kinds of entries:
//   {kind: 'text',  text}
//   {kind: 'image', bytes, mediaType, width, height, thumb}
// Images are captured because screenshots (GNOME's own PrtSc UI, WeChat's
// Alt+A capturer) put *only* image/* on the clipboard: St.Clipboard's four
// text mimetypes never match, so a text-only history silently drops them.
//
// Normalization (normalizeScreenshot): WeChat's Alt+A capturer advertises
// image/png, image/jpeg, image/webp, image/bmp and application/x-qt-image,
// but serves the *same BMP bytes* under every one of them. St.Clipboard and
// GdkPixbuf decode those bytes fine, so the history never noticed; anything
// that trusts the declared type (web apps, DSH's attachment pipeline) rejects
// them. The fix is to decode whatever arrived and write genuine PNG back
// under image/png.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {PanelFeature} from '../core/feature.js';
import {getVirtualKeyboard} from '../core/input.js';

// The mimetypes St.Clipboard itself knows about (st-clipboard.c
// supported_mimetypes): text/plain;charset=utf-8, UTF8_STRING, text/plain,
// STRING. get_text() picks the first one the current owner actually offers and
// calls back with null when none match - which is the signal that the clipboard
// holds something else (an image, a file, ...).

// Image mimetypes to try, in order. image/png first because that is what
// GNOME's own screenshot tool publishes; image/bmp covers the Qt-based
// capturers (WeChat advertises png/jpeg/bmp/... but serves BMP bytes under
// every one of them, so the declared name is worthless and we decode whatever
// comes back). Deliberately not trying xpm/xbm/ppm/pgm/pbm: GdkPixbuf cannot
// decode those and the request just costs a round-trip.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/bmp', 'image/webp'];

// GdkPixbuf format names that need no normalization: their bytes already
// match the mimetype we advertise back to clients. Everything else (bmp,
// tiff, ico, ...) is pushed through the PNG encoder on normalize.
const NATIVE_FORMATS = new Set(['png', 'jpeg', 'webp', 'gif']);

const CLIP_LABEL_MAX = 42;
const OSD_ICON = new Gio.ThemedIcon({name: 'edit-copy-symbolic'});
// Copies arriving within this window are treated as one copy (apps may churn
// the clipboard ownership a few times for a single Ctrl+C).
const OSD_DEBOUNCE_MS = 750;
// Longest edge of the thumbnail stored with each image entry, in logical px.
const THUMB_SIZE = 96;
// An image whose decoded size exceeds this is not stored (screenshots of a
// multi-monitor 4K setup land around 30-50MP).
const MAX_IMAGE_PIXELS = 64 * 1000 * 1000;
// These bytes live in the gnome-shell process, which cannot page them out to
// disk: a history full of 4K screenshots would bloat the compositor and take
// the whole desktop down with it on OOM. Oldest images are evicted past this.
const IMAGE_BUDGET_BYTES = 32 * 1000 * 1000;

/**
 * Decode clipboard image bytes without trusting the declared mimetype.
 * @param {Uint8Array} data - raw bytes from St.Clipboard.get_content()
 * @returns {{pixbuf: GdkPixbuf.Pixbuf, width: number, height: number,
 *            sourceFormat: string|null}|null} decoded image or null
 */
function decodeClipboardImage(data) {
    if (!data || !data.length)
        return null;

    let pixbuf = null;
    let sourceFormat = null;
    try {
        const loader = GdkPixbuf.PixbufLoader.new();
        loader.write(data);
        loader.close();
        pixbuf = loader.get_pixbuf();
        // get_format() stays valid after close() and names the *actual*
        // container (bmp for WeChat's fake PNG), which is what tells us
        // whether the declared mimetype was a lie.
        const format = loader.get_format();
        sourceFormat = format ? format.get_name() : null;
    } catch (e) {
        // Not an image GdkPixbuf understands (or a lying mimetype).
        return null;
    }
    if (!pixbuf)
        return null;

    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    if (!width || !height || width * height > MAX_IMAGE_PIXELS)
        return null;

    return {pixbuf, width, height, sourceFormat};
}

/**
 * Re-encode a decoded pixbuf as PNG bytes.
 * @param {GdkPixbuf.Pixbuf} pixbuf - decoded source image
 * @returns {Uint8Array|null} PNG bytes, or null when encoding fails
 */
function encodePng(pixbuf) {
    try {
        const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
        return ok && buffer?.length ? buffer : null;
    } catch (e) {
        return null;
    }
}

/**
 * Whether a GdkPixbuf format name is one whose bytes already match the
 * mimetype clients will be told about, so no re-encoding is needed.
 * @param {string|null} format - GdkPixbuf format name from the loader
 * @returns {boolean} true for png/jpeg/webp/gif
 */
function isNativeFormat(format) {
    return format === null || NATIVE_FORMATS.has(format);
}

export class ClipboardManager extends Signals.EventEmitter {
    constructor(settings) {
        super();

        this._settings = settings;
        this._clipboard = St.Clipboard.get_default();
        this._history = [];
        this._privacy = false;
        // Last entry signature (text body or image hash) for dedup.
        this._lastContent = null;
        this._busy = false;
        this._destroyed = false;
        this._lastCopyMs = 0;
        // true while this manager itself writes the clipboard (setClip/paste),
        // so the resulting owner-changed does not pop a "copied" toast
        this._internalWrite = false;
        // Set when a copy happened while a fetch was in flight, so the newer
        // clipboard content is not lost (the fetch is for the older owner).
        this._pendingFetch = false;
        // True while the clipboard holds an image whose *real* container is
        // not one browsers accept (WeChat Alt+A ships BMP bytes under an
        // image/png name). Gates the manual "截图转 PNG" entry so a rescue
        // action is not parked permanently above the history list.
        this._needsNormalize = false;

        const display = Shell.Global.get().get_display();
        this._selection = display.get_selection();
        this._selectionId = this._selection.connect('owner-changed',
            (selection, selectionType) => {
                if (selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD)
                    return;

                // Nothing to fetch and nothing was copied: the clipboard was
                // cleared (lock screen, xclip -c, an app tearing down its
                // selection). MetaSelection emits owner-changed with a NULL
                // owner for that, but Meta.Selection.get_current_owner() is
                // not introspectable in gnome-shell 50, so probe the mimetype
                // list instead - it is NULL only when there is no owner.
                if (!this._mimeTypes().length) {
                    this._setNeedsNormalize(false);
                    return;
                }

                // Notify first, before the fetch gate: _busy can sit in a
                // transfer for a while (slow/unresponsive clipboard owners),
                // and users expect a toast the moment they copy. Throttled so
                // selection churn does not spam toasts.
                const now = GLib.get_monotonic_time() / 1000;
                if (!this._privacy && !this._internalWrite &&
                    now - this._lastCopyMs > OSD_DEBOUNCE_MS) {
                    this._lastCopyMs = now;
                    this.emit('copied');
                }
                this._onSelectionChanged();
            });

        this._settingsChangedId = settings.connect('changed::history-size',
            () => this._trim());
    }

    get history() {
        return this._history;
    }

    // Whether the clipboard image at hand really needs re-encoding. The UI
    // shows its manual entry only while this is true.
    get needsNormalize() {
        return this._needsNormalize;
    }

    _setNeedsNormalize(value) {
        if (this._needsNormalize === value)
            return;
        this._needsNormalize = value;
        this.emit('normalize-changed');
    }

    get privateMode() {
        return this._privacy;
    }

    setPrivateMode(enabled) {
        this._privacy = enabled;
        if (enabled) {
            this.clearHistory();
            this._setNeedsNormalize(false);
        }
        this.emit('privacy-changed', enabled);
    }

    _onSelectionChanged() {
        if (this._privacy)
            return;
        // A fetch is already running for an older owner. Remember that newer
        // content exists so _fetch() can re-run once it finishes, instead of
        // dropping the copy on the floor.
        if (this._busy) {
            this._pendingFetch = true;
            return;
        }
        this._fetch();
    }

    // Mimetypes the current clipboard owner offers, or [] when it has none.
    _mimeTypes() {
        try {
            return this._clipboard.get_mimetypes(
                St.ClipboardType.CLIPBOARD) ?? [];
        } catch (e) {
            return [];
        }
    }

    _fetch() {
        this._busy = true;
        this._pendingFetch = false;

        let settled = false;
        let timeoutId = 0;
        const settle = () => {
            if (settled)
                return;
            settled = true;
            this._busy = false;
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
            if (this._pendingFetch && !this._destroyed) {
                this._pendingFetch = false;
                this._fetch();
            }
        };

        // get_mimetypes() tells us what the owner actually offers, so we can
        // request a type it supports instead of blind-probing four of them.
        const mimetypes = this._mimeTypes();

        const hasText = mimetypes.some(m => m.startsWith('text/') ||
            m === 'UTF8_STRING' || m === 'STRING');
        const hasImage = !hasText &&
            mimetypes.some(m => m.startsWith('image/') ||
                m === 'application/x-qt-image');
        const includeImages = this._settings.get_boolean(
            'history-include-images');

        if (hasText) {
            this._clipboard.get_text(St.ClipboardType.CLIPBOARD,
                (clipboard, text) => {
                    if (this._destroyed)
                        return;
                    settle();
                    // Plain text on the clipboard: nothing to normalize.
                    this._setNeedsNormalize(false);
                    if (text)
                        this._pushText(text);
                });
        } else if (hasImage && includeImages) {
            this._fetchImage(settle);
        } else {
            // Neither text nor a captured image: no image we can promise to
            // fix, so drop any stale affordance from the previous owner.
            settle();
            this._setNeedsNormalize(false);
            return;
        }

        // safety: a stalled owner must never freeze the feature
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            timeoutId = 0;
            if (!this._destroyed)
                settle();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Try the image mimetypes in order; decode and store the first that yields
    // a usable pixbuf.
    _fetchImage(settle) {
        let index = 0;
        const tryNext = () => {
            if (this._destroyed) {
                settle();
                return;
            }
            if (index >= IMAGE_TYPES.length) {
                settle();
                return;
            }
            const mediaType = IMAGE_TYPES[index++];
            this._clipboard.get_content(St.ClipboardType.CLIPBOARD, mediaType,
                (clipboard, bytes) => {
                    if (this._destroyed) {
                        settle();
                        return;
                    }
                    if (!bytes || bytes.get_size() === 0) {
                        tryNext();
                        return;
                    }
                    const decoded = decodeClipboardImage(bytes.get_data());
                    if (!decoded) {
                        // Right mimetype name, unusable/deceptive bytes: try
                        // the next candidate before giving up.
                        tryNext();
                        return;
                    }
                    settle();
                    // Surface the rescue entry only for a genuine container
                    // mismatch (declared image/*, bytes are bmp/tiff/...).
                    this._setNeedsNormalize(!isNativeFormat(decoded.sourceFormat));
                    const entry = this._entryFromDecoded(decoded);
                    if (entry)
                        this._pushEntry(entry);
                    // Auto-normalization runs after the history entry is in,
                    // so a conversion failure never costs the capture.
                    if (this._settings.get_boolean('normalize-screenshots') &&
                        this._settings.get_boolean('normalize-on-copy') &&
                        !isNativeFormat(decoded.sourceFormat))
                        this._rewriteAsPng(decoded);
                });
        };
        tryNext();
    }

    // Build a history entry from already-decoded clipboard bytes.
    _entryFromDecoded(decoded) {
        const {pixbuf, width, height} = decoded;
        // Store PNG so the entry can be handed straight back to the clipboard.
        const png = encodePng(pixbuf);
        if (!png)
            return null;

        return {
            kind: 'image',
            bytes: png,
            mediaType: 'image/png',
            width,
            height,
            thumb: this._makeThumb(pixbuf),
            // Dedup key: distinguishes screenshots of the same size.
            digest: this._digest(png),
        };
    }

    /**
     * Rewrite the clipboard image as genuine PNG when its declared mimetype is
     * a lie (WeChat Alt+A: image/png declared, BMP bytes served). Idempotent:
     * an image whose bytes already match a browser-accepted container is left
     * untouched, so pressing the shortcut twice never re-encodes or steals
     * clipboard ownership from an unmodified screenshot.
     * @returns {Promise<'converted'|'native'|'no-image'|'undecodable'|'failed'>}
     */
    normalizeScreenshot() {
        return new Promise(resolve => {
            if (this._destroyed) {
                resolve('failed');
                return;
            }

            const mimetypes = this._mimeTypes();
            const hasText = mimetypes.some(m => m.startsWith('text/') ||
                m === 'UTF8_STRING' || m === 'STRING');
            const imageType = IMAGE_TYPES.find(t => mimetypes.includes(t)) ??
                (mimetypes.includes('application/x-qt-image')
                    ? 'application/x-qt-image'
                    : null);

            // No image, or an image *plus* text: leave the clipboard alone.
            // Overwriting a rich copy with image-only bytes would silently
            // destroy the text half the user may be about to paste.
            if (!imageType || hasText) {
                resolve('no-image');
                return;
            }

            this._clipboard.get_content(St.ClipboardType.CLIPBOARD, imageType,
                (clipboard, bytes) => {
                    if (this._destroyed) {
                        resolve('failed');
                        return;
                    }
                    const decoded = bytes?.get_size()
                        ? decodeClipboardImage(bytes.get_data())
                        : null;
                    if (!decoded) {
                        resolve('undecodable');
                        return;
                    }
                    if (isNativeFormat(decoded.sourceFormat)) {
                        resolve('native');
                        return;
                    }
                    resolve(this._rewriteAsPng(decoded) ? 'converted' : 'failed');
                });
        });
    }

    // Encode decoded pixels as PNG and take over the clipboard with them.
    // _internalWrite keeps the resulting owner-changed from popping a second
    // "copied" toast, exactly like setClip().
    _rewriteAsPng(decoded) {
        const png = encodePng(decoded.pixbuf);
        if (!png)
            return false;
        this._writeImageBytes(png, 'image/png');
        // The clipboard now carries genuine PNG, so the rescue entry has
        // nothing left to do until another mislabelled image shows up.
        this._setNeedsNormalize(false);
        return true;
    }

    // Build an St.ImageContent from a scaled copy of the pixbuf.
    _makeThumb(pixbuf) {
        const {width: w, height: h} = pixbuf;
        const scale = Math.min(1, THUMB_SIZE / Math.max(w, h));
        const tw = Math.max(1, Math.round(w * scale));
        const th = Math.max(1, Math.round(h * scale));
        let scaled = pixbuf;
        try {
            if (scale < 1) {
                scaled = pixbuf.scale_simple(tw, th,
                    GdkPixbuf.InterpType.BILINEAR);
            }
            if (!scaled)
                return null;
            // ImageContent wants tightly packed RGBA_8888; pixbufs for
            // screenshots are usually 3-channel BGR, so force an alpha channel.
            const rgba = scaled.get_n_channels() === 4
                ? scaled
                : scaled.add_alpha(false, 0, 0, 0);
            if (!rgba)
                return null;

            const content = St.ImageContent.new_with_preferred_size(
                rgba.get_width(), rgba.get_height());
            const coglContext =
                global.stage.context.get_backend().get_cogl_context();
            content.set_bytes(coglContext,
                rgba.read_pixel_bytes(),
                Cogl.PixelFormat.RGBA_8888,
                rgba.get_width(), rgba.get_height(),
                rgba.get_rowstride());
            return content;
        } catch (e) {
            // Thumbnail is cosmetic: a failure must not lose the entry.
            return null;
        }
    }

    _digest(bytes) {
        const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
        checksum.update(bytes);
        return checksum.get_string();
    }

    _pushText(text) {
        if (!text.trim())
            return;
        const maxLen = this._settings.get_int('max-entry-length');
        const body = text.length > maxLen ? text.slice(0, maxLen) : text;
        this._pushEntry({kind: 'text', text: body});
    }

    _pushEntry(entry) {
        const signature = entry.kind === 'text'
            ? `text:${entry.text}`
            : `image:${entry.digest}`;
        if (signature === this._lastContent)
            return;
        this._lastContent = signature;

        const idx = this._history.findIndex(e => this._entrySignature(e) ===
            signature);
        if (idx === 0)
            return;
        if (idx > 0)
            this._history.splice(idx, 1);

        this._history.unshift(entry);
        this._trim();
        this._trimImageBudget();
        this.emit('history-changed');
    }

    // Evict the oldest image entries while their total PNG bytes exceed the
    // budget. Text entries are cheap and never touched.
    _trimImageBudget() {
        let total = 0;
        for (const e of this._history) {
            if (e.kind === 'image')
                total += e.bytes.length;
        }
        if (total <= IMAGE_BUDGET_BYTES)
            return;

        // Walk from the oldest end; the newest image is always kept so a
        // burst of large screenshots cannot empty the list.
        for (let i = this._history.length - 1;
            i >= 0 && total > IMAGE_BUDGET_BYTES; i--) {
            const e = this._history[i];
            if (e.kind !== 'image')
                continue;
            if (!this._history.slice(0, i).some(x => x.kind === 'image'))
                break;   // this is the newest image, keep it
            total -= e.bytes.length;
            this._history.splice(i, 1);
        }
    }

    _entrySignature(entry) {
        return entry.kind === 'text'
            ? `text:${entry.text}`
            : `image:${entry.digest}`;
    }

    _trim() {
        const max = this._settings.get_int('history-size');
        if (this._history.length > max)
            this._history.length = max;
    }

    setClip(entry) {
        this._lastContent = this._entrySignature(entry);
        if (entry.kind === 'image') {
            this._writeImageBytes(entry.bytes, entry.mediaType);
            return;
        }
        this._busy = true;
        this._internalWrite = true;
        // Drop any queued refetch: the clipboard is ours now.
        this._pendingFetch = false;
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
        this._armWriteWindow();
    }

    // Take over the clipboard with image bytes under the given mimetype. The
    // fetch gate and the internal-write marker are armed here so both setClip()
    // and the normalizer's rewrite behave identically: no refetch of our own
    // content, no duplicate "copied" toast.
    _writeImageBytes(bytes, mediaType) {
        this._busy = true;
        this._internalWrite = true;
        this._pendingFetch = false;
        this._clipboard.set_content(St.ClipboardType.CLIPBOARD, mediaType,
            new GLib.Bytes(bytes));
        this._armWriteWindow();
    }

    // Hold the fetch gate closed long enough for our own selection change to
    // arrive and be ignored, then release it. A copy that landed during the
    // window set _pendingFetch but could not start a fetch (the gate was shut),
    // so the release must kick one off or that external copy is lost.
    _armWriteWindow() {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            this._busy = false;
            this._internalWrite = false;
            if (this._pendingFetch) {
                this._pendingFetch = false;
                this._fetch();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    paste(entry) {
        this.setClip(entry);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            if (!this._destroyed)
                this._simulatePaste();
            return GLib.SOURCE_REMOVE;
        });
    }

    // A virtual device must outlive mutter's asynchronous input-thread
    // dispatch, so use the shared cached device (core/input.js).
    _simulatePaste() {
        const device = getVirtualKeyboard();
        if (!device)
            return;
        try {
            const t = GLib.get_monotonic_time();
            device.notify_keyval(t, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            device.notify_keyval(t + 1000, Clutter.KEY_Insert, Clutter.KeyState.PRESSED);
            device.notify_keyval(t + 2000, Clutter.KEY_Insert, Clutter.KeyState.RELEASED);
            device.notify_keyval(t + 3000, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        } catch (e) {
            log(`gnome-toolbox: paste simulation failed: ${e.message}`);
        }
    }

    clearHistory() {
        this._history = [];
        this._lastContent = null;
        this.emit('history-changed');
    }

    destroy() {
        this._destroyed = true;
        this._selection.disconnect(this._selectionId);
        if (this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);
        this.emit('destroy');
    }
}

export class ClipboardFeature extends PanelFeature {
    constructor(ctx) {
        super(ctx);
        this._clipManager = ctx.clipboard;
        this._clipManagerId = 0;
        this._clipPrivacyId = 0;
        this._clipCopiedId = 0;
        this._clipSettingsId = 0;
        this._normalizeItem = null;
        this._keybindingRegistered = false;
    }

    get id() {
        return 'clipboard';
    }

    get settingsKey() {
        return 'enable-clipboard';
    }

    buildMenu(menu) {
        const clipHeader = new PopupMenu.PopupMenuItem('剪贴板历史', {reactive: false, can_focus: false});
        clipHeader.actor.add_style_class_name('gtb-section-header');
        menu.addMenuItem(clipHeader);

        this._privacyItem = new PopupMenu.PopupSwitchMenuItem('隐私模式', false);
        this._privacyItem.connect('toggled', item => {
            this._clipManager.setPrivateMode(item.state);
        });
        menu.addMenuItem(this._privacyItem);

        this._clearItem = new PopupMenu.PopupMenuItem('清空历史');
        this._clearItem.connect('activate', () => this._clipManager.clearHistory());
        menu.addMenuItem(this._clearItem);

        // Screenshot normalization: the fix for capturers that declare
        // image/png but ship BMP (WeChat Alt+A), which browsers and DSH
        // reject even though the bytes are a perfectly good image.
        // Hidden by default: it only shows up while the clipboard really
        // holds such an image (_syncNormalizeAffordances), so the history
        // area is not permanent home to a rescue action that reads like a
        // stray history row.
        this._normalizeItem = new PopupMenu.PopupMenuItem('截图转 PNG');
        this._normalizeItem.visible = false;
        this._normalizeItem.connect('activate', () => this._normalizeNow());
        menu.addMenuItem(this._normalizeItem);

        this._historySection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._historySection);
    }

    enable() {
        this._clipManagerId = this._clipManager.connect('history-changed', () =>
            this._renderHistory());
        this._clipCopiedId = this._clipManager.connect('copied',
            () => this._showCopiedOsd());
        // setToggleState() re-emits 'toggled' even when unchanged; only sync
        // when the switch actually differs, or the privacy-changed -> toggled
        // echo feeds back into setPrivateMode and spins the main loop.
        this._clipPrivacyId = this._clipManager.connect('privacy-changed',
            (_mgr, enabled) => {
                if (this._privacyItem && this._privacyItem.state !== enabled)
                    this._privacyItem.setToggleState(enabled);
            });
        this._clipSettingsId = this.ctx.settings.connect('changed',
            (_settings, key) => {
                if (key === 'paste-on-select')
                    this._renderHistory();
                else if (key === 'normalize-screenshots')
                    this._syncNormalizeAffordances();
            });
        this._clipNormalizeId = this._clipManager.connect('normalize-changed',
            () => this._syncNormalizeAffordances());
        this._syncNormalizeAffordances();
        this._renderHistory();
    }

    disable() {
        for (const key of ['_clipManagerId', '_clipCopiedId',
            '_clipPrivacyId', '_clipSettingsId', '_clipNormalizeId']) {
            if (this[key]) {
                if (key === '_clipSettingsId')
                    this.ctx.settings.disconnect(this[key]);
                else
                    this._clipManager.disconnect(this[key]);
                this[key] = 0;
            }
        }
        this._unregisterKeybinding();
        this._normalizeItem = null;
    }

    // Register the "convert now" accelerator straight from the gsettings array
    // key, the same way shell's own screenshot bindings are wired. An empty
    // array is a legal value and simply yields Meta.KeyBindingAction.NONE.
    _registerKeybinding() {
        if (this._keybindingRegistered)
            return;
        try {
            Main.wm.addKeybinding('normalize-shortcut', this.ctx.settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._normalizeNow());
            this._keybindingRegistered = true;
        } catch (e) {
            log(`gnome-toolbox: could not register normalize shortcut: ${e.message}`);
        }
    }

    _unregisterKeybinding() {
        if (!this._keybindingRegistered)
            return;
        try {
            Main.wm.removeKeybinding('normalize-shortcut');
        } catch (e) {
            log(`gnome-toolbox: could not remove normalize shortcut: ${e.message}`);
        }
        this._keybindingRegistered = false;
    }

    // Two independent conditions gate the manual entry: the feature switch,
    // and whether the clipboard image actually needs re-encoding. Anything
    // else and the entry stays invisible — the shortcut covers the rest, and
    // a permanently parked "截图转 PNG" row above the history read like a
    // broken history item. The shortcut follows the switch only, so it stays
    // available even when no mislabelled image is on the clipboard.
    _syncNormalizeAffordances() {
        const enabled = this.ctx.settings.get_boolean('normalize-screenshots');
        if (this._normalizeItem) {
            this._normalizeItem.visible =
                enabled && this._clipManager.needsNormalize;
        }
        if (enabled)
            this._registerKeybinding();
        else
            this._unregisterKeybinding();
    }

    // Silent by design: pressing the shortcut is already an explicit intent,
    // so an OSD would only be noise on every screenshot. Failures go to the
    // journal for diagnosis and never to the screen.
    _normalizeNow() {
        if (!this.ctx.settings.get_boolean('normalize-screenshots'))
            return;
        this._clipManager.normalizeScreenshot().then(result => {
            if (result === 'failed' || result === 'undecodable')
                log(`gnome-toolbox: screenshot normalize: ${result}`);
        }).catch(e =>
            log(`gnome-toolbox: screenshot normalize failed: ${e.message}`));
    }

    _showCopiedOsd() {
        if (!this.ctx.settings.get_boolean('show-clipboard-osd'))
            return;
        Main.osdWindowManager.showAll(OSD_ICON, '复制成功');
    }

    _renderHistory() {
        const section = this._historySection;
        if (!section)
            return;
        section.removeAll();
        const history = this._clipManager.history;
        const pasteOnSelect = this.ctx.settings.get_boolean('paste-on-select');

        if (!history.length) {
            const empty = new PopupMenu.PopupMenuItem('（空）', {reactive: false, can_focus: false});
            empty.actor.add_style_class_name('gtb-dim');
            section.addMenuItem(empty);
            return;
        }

        for (const entry of history) {
            const item = entry.kind === 'image'
                ? this._buildImageItem(entry, pasteOnSelect)
                : this._buildTextItem(entry, pasteOnSelect);
            section.addMenuItem(item);
        }
    }

    _buildTextItem(entry, pasteOnSelect) {
        const short = entry.text.replace(/\s+/g, ' ').trim();
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
        return item;
    }

    // Image entries show a thumbnail plus the pixel size, because a run of
    // screenshots is otherwise indistinguishable in the list.
    _buildImageItem(entry, pasteOnSelect) {
        const item = new PopupMenu.PopupMenuItem('', {});
        item.label.hide();

        const icon = new St.Icon({
            gicon: entry.thumb,
            icon_size: 32,
            style_class: 'gtb-clip-thumb',
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.insert_child_at_index(icon, 1);

        const text = new St.Label({
            text: `图片 ${entry.width}×${entry.height}`,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(text);
        item.label_actor = text;

        item.connect('activate', () => {
            if (pasteOnSelect)
                this._clipManager.paste(entry);
            else
                this._clipManager.setClip(entry);
        });
        return item;
    }
}
