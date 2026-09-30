// ToolboxIndicator: thin panel shell hosting the active features.
// It owns the top-bar actor strip and the shared dropdown menu; the
// actual content (vitals rows, lock key switches, clipboard history) is
// contributed by PanelFeature implementations via rebuild().

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export const ToolboxIndicator = GObject.registerClass(
class ToolboxIndicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.0, 'ToolboxIndicator');

        this._extension = extension;
        this._settings = settings;
        this._features = [];

        this._actor = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'gtb-panel',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._actor);
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

        // Hide the button when no enabled feature shows panel actors
        // (e.g. only the tray feature is on: hosted indicators own their
        // buttons and contribute nothing here).
        this.visible = features.some(f => f.panelActors().length > 0);
    }

    _onDestroy() {
        this._features = [];
        super._onDestroy();
    }
});
