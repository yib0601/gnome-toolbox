// gnome-toolbox: aggregated top-bar toolbox for GNOME Shell 51.
// Combines system vitals monitoring, lock-key indicators, clipboard
// history and AppIndicator/KStatusNotifierItem tray support.
// The tray subsystem is derived from gnome-shell-extension-appindicator
// (GPL-2.0-or-later).
//
// Assembly model: every capability is a PanelFeature (core/feature.js).
// extension.js builds the feature registry, applies the gsettings
// enable-* switches (hot toggling via indicator.rebuild()) and owns the
// panel placement. Features own their timers/signals; the indicator is
// only a shell.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Extension from 'resource:///org/gnome/shell/extensions/extension.js';

import {Logger} from './core/logger.js';
import {SettingsManager, getDefaultGSettings} from './core/settings.js';
import {disposeVirtualKeyboard} from './core/input.js';

import * as Interfaces from './tray/interfaces.js';
import * as TrayIconsManager from './tray/trayIconsManager.js';
import * as Util from './tray/util.js';
import * as StatusNotifierWatcher from './tray/statusNotifierWatcher.js';

import {ToolboxIndicator} from './indicator.js';
import {VitalsFeature} from './features/vitals.js';
import {LockKeysFeature} from './features/lockkeys.js';
import {ClipboardManager, ClipboardFeature} from './features/clipboard.js';
import {TrayFeature} from './features/tray.js';

const INDICATOR_ROLE = 'gnome-toolbox';

export default class GnomeToolboxExtension extends Extension.Extension {
    constructor(...args) {
        super(...args);

        Logger.init(this);
        Interfaces.initialize(this);

        this._isEnabled = false;
        this._trayFeature = null;
        this._watchDog = new Util.NameWatcher(StatusNotifierWatcher.WATCHER_BUS_NAME);
        this._watchDog.connect('vanished', () => this._trayFeature?.maybeClaimName());

        // Handle extension reload: drop the stale watchdog of the old copy.
        if (typeof global['--gnome-toolbox-on-reload'] === 'function')
            global['--gnome-toolbox-on-reload']();

        global['--gnome-toolbox-on-reload'] = () => {
            Logger.debug('Reload detected, destroying old watchdog');
            this._watchDog.destroy();
            this._watchDog = null;
        };
    }

    get isEnabled() {
        return this._isEnabled;
    }

    enable() {
        this._isEnabled = true;

        SettingsManager.initialize(this);
        this._settings = getDefaultGSettings();

        // Clipboard history state outlives the feature wrapper (the feature
        // only owns UI + listeners), so the manager lives on the extension.
        this._clipboardManager = new ClipboardManager(this._settings);

        const ctx = {
            extension: this,
            settings: this._settings,
            clipboard: this._clipboardManager,
            watchDog: this._watchDog,
        };
        this._features = [
            new VitalsFeature(ctx),
            new LockKeysFeature(ctx),
            new ClipboardFeature(ctx),
            new TrayFeature(ctx),
        ];
        this._trayFeature = this._features.find(f => f.id === 'tray');

        this._indicator = new ToolboxIndicator(this, this._settings);
        this._placeIndicator();

        this._placementIds = [
            this._settings.connect('changed::panel-box', () => this._placeIndicator()),
            this._settings.connect('changed::panel-position', () => this._placeIndicator()),
        ];

        // Hot toggling: each feature reacts to its enable-* switch.
        this._switchIds = this._features.map(f =>
            this._settings.connect(`changed::${f.settingsKey}`,
                () => this._applyFeatureState(f)));

        for (const f of this._features)
            this._applyFeatureState(f);

        // Legacy XEmbed tray has its own sub-switch handled internally.
        TrayIconsManager.TrayIconsManager.initialize();
    }

    disable() {
        this._isEnabled = false;

        for (const id of this._switchIds ?? [])
            this._settings.disconnect(id);
        this._switchIds = [];

        for (const id of this._placementIds ?? [])
            this._settings.disconnect(id);
        this._placementIds = [];

        for (const f of this._features ?? [])
            f.destroy();
        this._features = [];
        this._trayFeature = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._clipboardManager) {
            this._clipboardManager.destroy();
            this._clipboardManager = null;
        }

        TrayIconsManager.TrayIconsManager.destroy();
        disposeVirtualKeyboard();
        SettingsManager.destroy();
    }

    _activeFeatures() {
        return this._features.filter(f =>
            this._settings.get_boolean(f.settingsKey));
    }

    // Enable/disable one feature according to its switch. Rebuild the
    // indicator shell around the state change so the feature sees a live
    // UI when enabling and leaves no dead UI behind when disabling.
    _applyFeatureState(feature) {
        const on = this._settings.get_boolean(feature.settingsKey);
        if (on === feature.active)
            return;

        feature.active = on;
        if (on) {
            this._indicator.rebuild(this._activeFeatures());
            feature.enable();
        } else {
            feature.disable();
            this._indicator.rebuild(this._activeFeatures());
        }
    }

    // Move the indicator into the configured panel section. addToStatusArea()
    // refuses a role that is already taken, and _addToPanelBox() re-parents the
    // existing container, so releasing the role first is enough to move it.
    _placeIndicator() {
        if (!this._indicator || !this._settings)
            return;

        const box = this._settings.get_string('panel-box');
        const position = this._settings.get_int('panel-position');

        Main.panel.statusArea[INDICATOR_ROLE] = null;
        Main.panel.addToStatusArea(INDICATOR_ROLE, this._indicator, position, box);
    }
}
