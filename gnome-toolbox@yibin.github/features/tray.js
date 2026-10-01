// Tray feature: AppIndicator / KStatusNotifierItem support. Claims
// org.kde.StatusNotifierWatcher and hosts indicator icons. No panel
// actors or menu sections of its own — hosted indicators manage their
// own panel buttons. The legacy XEmbed tray (trayIconsManager.js) is a
// separate sub-switch (legacy-tray-enabled) managed by the extension.

import {PanelFeature} from '../core/feature.js';
import * as Util from '../tray/util.js';
import * as StatusNotifierWatcher from '../tray/statusNotifierWatcher.js';

export class TrayFeature extends PanelFeature {
    constructor(ctx) {
        super(ctx);
        this._watcher = null;
        this._watchDog = ctx.watchDog;
    }

    get id() {
        return 'tray';
    }

    get settingsKey() {
        return 'enable-tray';
    }

    enable() {
        Util.tryCleanupOldIndicators();
        this.maybeClaimName();
    }

    disable() {
        if (this._watcher !== null) {
            this._watcher.destroy();
            this._watcher = null;
        }
    }

    // When another watcher holds the bus name, wait for it to vanish before
    // claiming it (mirrors upstream behaviour on lock-screen transitions).
    // Also invoked from the extension's watchdog 'vanished' callback.
    maybeClaimName() {
        if (!this.active || this._watcher || !this.ctx.extension.isEnabled)
            return;

        if (this._watchDog.nameAcquired && this._watchDog.nameOnBus)
            return;

        this._watcher = new StatusNotifierWatcher.StatusNotifierWatcher(
            this.ctx.extension, this._watchDog);
    }
}
