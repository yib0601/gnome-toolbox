// MenuScroll: keep the toolbox dropdown inside the screen and scrollable.
//
// The dropdown is a plain PanelMenu.PopupMenu: its content box goes straight
// into the BoxPointer's bin, and shell only clamps the height with
// `max-height` set by PanelMenu to the *whole work area*. The popup starts
// below the panel, though, so a long menu (clipboard history, tray items,
// player row) runs off the bottom edge and the rows below the screen can
// neither be seen nor scrolled to.
//
// This module owns exactly one thing: wrap the menu's content box in an
// St.ScrollView clamped to the space actually available, and keep the focused
// row inside view. It builds no menu items and knows no feature — indicator.js
// installs it once on the shared menu, and features keep adding items as
// before.
//
// Shell APIs are injected through `host` (dependency inversion): the shell
// side of the contract — work area, focus scrolling, monitor changes — lives in
// indicator.js, so this module imports nothing from resource:/// and can be
// exercised without a running shell (scripts/test-menuscroll.sh).
//
// Verified shell behaviour this relies on (checked against shell-src/):
// - St.ScrollView reports min_height = 0 whenever its vertical policy is not
//   NEVER (st-scroll-view.c), so a clamped viewport can shrink below its
//   content and the BoxPointer can still fit it on screen.
// - Its natural height is the child's natural height, and St.Bin's bin layout
//   hands the child exactly the allocated box, so a `max-height` on the
//   viewport reaches the popup's on-screen height.
// - St.ScrollView scrolls itself on wheel events and forwards focus navigation
//   to its child, but does not scroll the focused row into view; that is what
//   `host.ensureVisible` is for (shell's own message list does the same).

import GLib from 'gi://GLib';
import St from 'gi://St';

// Breathing room kept below the popup so its last row never touches the work
// area edge, in logical px.
const EDGE_GAP = 12;

const MENU_CONTENT_CLASS = 'popup-menu-content';

/**
 * Height the popup content may occupy.
 * @param {number} availableHeightPx logical px the host reports as free (work
 *   area minus the boxpointer's own decoration)
 * @returns {number} max-height in logical px, or 0 when there is no room
 */
export function clampHeight(availableHeightPx) {
    if (!Number.isFinite(availableHeightPx))
        return 0;
    const available = Math.floor(availableHeightPx) - EDGE_GAP;
    return available > 0 ? available : 0;
}

export class MenuScroll {
    /**
     * @param {object} menu PopupMenu.PopupMenu (needs .box, ._boxPointer.bin,
     *   `open-state-changed` and `active-changed` signals)
     * @param {object} host shell-side contract
     * @param {Function} host.availableHeight logical px left for the popup
     * @param {Function} host.ensureVisible `(scrollView, actor)` scrolls a row
     *   into view
     * @param {Function} [host.onLayoutChanged] `(callback) => unsubscribe`,
     *   fired when the work area changes
     */
    constructor(menu, host) {
        this._menu = menu;
        this._host = host;
        this._scroll = null;
        this._bin = null;
        this._openId = 0;
        this._activeId = 0;
        this._unsubscribeLayout = null;

        this._install();
    }

    /** The viewport wrapping the menu content, or null when not installed. */
    get scrollView() {
        return this._scroll;
    }

    destroy() {
        const menu = this._menu;
        if (this._openId) {
            menu.disconnect(this._openId);
            this._openId = 0;
        }
        if (this._activeId) {
            menu.disconnect(this._activeId);
            this._activeId = 0;
        }
        if (this._unsubscribeLayout) {
            this._unsubscribeLayout();
            this._unsubscribeLayout = null;
        }

        // Unwrap so the menu destroys the tree the way it built it.
        const scroll = this._scroll;
        this._scroll = null;
        if (scroll) {
            const box = menu.box;
            const bin = this._bin ?? menu._boxPointer?.bin;
            // Same reparent rule in reverse: the box must leave the viewport
            // before the bin can take it back.
            scroll.set_child(null);
            if (bin)
                bin.child = box;
            scroll.destroy();
        }
        this._bin = null;
        this._menu = null;
    }

    // --- internals ---------------------------------------------------------

    _install() {
        const menu = this._menu;
        const box = menu.box;
        const bin = menu._boxPointer?.bin;
        // Not a PopupMenu (PanelMenu's dummy menu has no boxpointer): nothing
        // to wrap, and the caller keeps working.
        if (!bin || !box)
            return;

        const scroll = new St.ScrollView({
            style_class: 'gtb-menu-scroll',
            // Never/automatic, not ALWAYS: an always-on scrollbar would keep
            // reserving its width for a menu that fits.
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });

        // The theme paints `.popup-menu-content` (padding, background, rounded
        // border) on the content box. Inside a viewport that paint would scroll
        // away with the rows, so move the class to the fixed viewport and leave
        // the inner box plain.
        if (box.has_style_class_name(MENU_CONTENT_CLASS)) {
            box.remove_style_class_name(MENU_CONTENT_CLASS);
            scroll.add_style_class_name(MENU_CONTENT_CLASS);
        }

        // Clutter refuses to reparent an actor that still has a parent
        // (g_warning + no-op), so the box leaves the bin explicitly before it
        // joins the viewport; the viewport then takes its place in the bin.
        bin.child = null;
        scroll.set_child(box);
        bin.child = scroll;

        this._scroll = scroll;
        this._bin = bin;

        this._openId = menu.connect('open-state-changed', (_menu, open) => {
            if (!open)
                return;
            this._syncHeight();
            this._resetScroll();
        });

        // Keyboard focus can move past the visible rows; the viewport does not
        // follow it by itself.
        this._activeId = menu.connect('active-changed', (_menu, item) => {
            const actor = item?.actor;
            if (!this._scroll || !actor)
                return;
            try {
                this._host.ensureVisible?.(this._scroll, actor);
            } catch (e) {
                // A row outside the viewport (e.g. a submenu's) is not an
                // error worth surfacing.
            }
        });

        this._unsubscribeLayout = this._host.onLayoutChanged?.(
            () => this._syncHeight()) ?? null;
    }

    // Recompute the clamp. Cheap and idempotent: runs on open and whenever the
    // work area changes (monitor hotplug, resolution, scale).
    _syncHeight() {
        const scroll = this._scroll;
        if (!scroll)
            return;

        // `max-height` clamps the *content* box and then the viewport adds its
        // own padding/border on top of it (st_theme_node_adjust_preferred_height
        // does MIN(natural, max_height) + height_inc), so the chrome has to come
        // out of the budget or the popup grows past the gap we reserved.
        const available = clampHeight(this._host.availableHeight?.() ?? 0) -
            this._chromeHeight(scroll);
        scroll.style = available > 0 ? `max-height: ${available}px;` : '';
    }

    // Vertical padding + border the viewport's own theme adds around its child.
    _chromeHeight(scroll) {
        try {
            scroll.ensure_style();
            const node = scroll.get_theme_node();
            if (!node)
                return 0;
            return node.get_padding(St.Side.TOP) + node.get_padding(St.Side.BOTTOM) +
                node.get_border_width(St.Side.TOP) + node.get_border_width(St.Side.BOTTOM);
        } catch (e) {
            return 0;
        }
    }

    // A freshly opened menu starts at the newest entries, like every other
    // shell popup, instead of wherever the previous open left it.
    _resetScroll() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scroll?.vadjustment?.set_value(0);
            return GLib.SOURCE_REMOVE;
        });
    }
}
