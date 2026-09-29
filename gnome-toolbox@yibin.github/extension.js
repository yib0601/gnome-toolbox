// gnome-toolbox: aggregated top-bar toolbox for GNOME Shell 51.
// Combines system vitals monitoring, lock-key indicators, clipboard
// history and AppIndicator/KStatusNotifierItem tray support.
// The tray subsystem is derived from gnome-shell-extension-appindicator
// (GPL-2.0-or-later).

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Extension from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Interfaces from './interfaces.js';
import * as StatusNotifierWatcher from './statusNotifierWatcher.js';
import * as TrayIconsManager from './trayIconsManager.js';
import * as Util from './util.js';
import {Logger} from './logger.js';
import {SettingsManager, getDefaultGSettings} from './settingsManager.js';

import {ClipboardManager} from './clipboardManager.js';
import {ToolboxIndicator} from './indicator.js';

export default class GnomeToolboxExtension extends Extension.Extension {
    constructor(...args) {
        super(...args);

        Logger.init(this);
        Interfaces.initialize(this);

        this._isEnabled = false;
        this._statusNotifierWatcher = null;
        this._watchDog = new Util.NameWatcher(StatusNotifierWatcher.WATCHER_BUS_NAME);
        this._watchDog.connect('vanished', () => this._maybeEnableAfterNameAvailable());

        // Handle extension reload: drop the stale watchdog of the old copy.
        if (typeof global['--gnome-toolbox-on-reload'] === 'function')
            global['--gnome-toolbox-on-reload']();

        global['--gnome-toolbox-on-reload'] = () => {
            Logger.debug('Reload detected, destroying old watchdog');
            this._watchDog.destroy();
            this._watchDog = null;
        };
    }

    enable() {
        this._isEnabled = true;

        SettingsManager.initialize(this);
        const settings = getDefaultGSettings();

        // ---- toolbox indicator (vitals + lock keys + clipboard) ----
        this._clipboardManager = new ClipboardManager(settings);

        let keyMap = null;
        try {
            // GNOME 51: Clutter.get_default_backend() was removed; reach the
            // backend through the stage's Clutter.Context instead.
            const backend = Clutter.get_default_backend
                ? Clutter.get_default_backend()
                : global.stage.get_context().get_backend();
            keyMap = backend.get_default_seat().get_keymap();
        } catch (e) {
            Logger.warn(`Could not obtain keymap: ${e.message}`);
        }

        this._indicator = new ToolboxIndicator(this, settings, this._clipboardManager);
        Main.panel.addToStatusArea('gnome-toolbox', this._indicator, 0, 'right');
        this._indicator.start(settings, keyMap);

        // ---- tray (AppIndicator / KStatusNotifierItem / legacy) ----
        Util.tryCleanupOldIndicators();
        this._maybeEnableAfterNameAvailable();
        TrayIconsManager.TrayIconsManager.initialize();
    }

    disable() {
        this._isEnabled = false;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._clipboardManager) {
            this._clipboardManager.destroy();
            this._clipboardManager = null;
        }

        TrayIconsManager.TrayIconsManager.destroy();

        if (this._statusNotifierWatcher !== null) {
            this._statusNotifierWatcher.destroy();
            this._statusNotifierWatcher = null;
        }

        SettingsManager.destroy();
    }

    // When another watcher holds the bus name, wait for it to vanish before
    // claiming it (mirrors upstream behaviour on lock-screen transitions).
    _maybeEnableAfterNameAvailable() {
        if (!this._isEnabled || this._statusNotifierWatcher)
            return;

        if (this._watchDog.nameAcquired && this._watchDog.nameOnBus)
            return;

        this._statusNotifierWatcher = new StatusNotifierWatcher.StatusNotifierWatcher(
            this, this._watchDog);
    }
}
