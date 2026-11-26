// ToolboxIndicator: thin panel shell hosting the active features.
// It owns the top-bar actor strip and the shared dropdown menu; the
// actual content (vitals rows, lock key switches, clipboard history) is
// contributed by PanelFeature implementations via rebuild().

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {MenuScroll} from './core/menuscroll.js';

export const ToolboxIndicator = GObject.registerClass(
class ToolboxIndicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.0, 'ToolboxIndicator');

        this._extension = extension;
        this._settings = settings;
        this._features = [];

        // The shared dropdown grows with every feature (clipboard history
        // alone can be dozens of rows), so it is wrapped in a viewport clamped
        // to the work area; without it the rows below the screen edge are
        // unreachable. The shell side of that contract lives here.
        this._menuScroll = new MenuScroll(this.menu, {
            availableHeight: () => this._availableMenuHeight(),
            ensureVisible: (scrollView, actor) =>
                ensureActorVisibleInScrollView(scrollView, actor),
            onLayoutChanged: callback => {
                const id = Main.layoutManager.connect('monitors-changed', callback);
                return () => Main.layoutManager.disconnect(id);
            },
        });

        this._actor = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'gtb-panel',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._actor);
    }

    // Logical px the popup's *content* may occupy on this monitor.
    // getWorkAreaForMonitor() already excludes the top bar (the panel is a
    // chrome actor with affectsStruts), so the panel height is not subtracted
    // again. What it does not know about is the boxpointer's own decoration:
    // the theme's `.popup-menu.panel-menu { margin-bottom: 1.75em }` plus the
    // arrow rise both add to the popup's on-screen height, so a viewport
    // clamped to the bare work area would push the last rows past the edge.
    _availableMenuHeight() {
        const actor = this.menu.actor;
        const monitorIndex = Main.layoutManager.findIndexForActor(this);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        const margins = actor.margin_top + actor.margin_bottom;
        const themeNode = actor.get_theme_node();
        const arrowRise = themeNode ? themeNode.get_length('-arrow-rise') : 0;

        // Same arithmetic as PanelMenu's own max-height: margins are physical
        // px, the work area is physical px, CSS lengths (arrow rise) are
        // logical px.
        return (workArea.height - margins) / scaleFactor - arrowRise;
    }

    // Rebuild the panel actor strip and the dropdown menu from the given
    // active features. Called on enable/disable and on feature hot-toggle;
    // features recreate their menu items here (previous ones are destroyed
    // by menu.removeAll()).
    rebuild(features) {
        this._actor.remove_all_children();
        this.menu.removeAll();
        this._features = features;

        for (const feature of features) {
            for (const actor of feature.panelActors())
                this._actor.add_child(actor);
            feature.buildMenu(this.menu);
        }

        // Preferences entry: opens the extension settings window (panel
        // placement, readouts, clipboard behaviour).
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefsItem = new PopupMenu.PopupMenuItem('设置');
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);

        // Hide the button when no enabled feature shows panel actors
        // (e.g. only the tray feature is on: hosted indicators own their
        // buttons and contribute nothing here).
        this.visible = features.some(f => f.panelActors().length > 0);
    }

    _onDestroy() {
        this._features = [];
        this._menuScroll?.destroy();
        this._menuScroll = null;
        super._onDestroy();
    }
});
