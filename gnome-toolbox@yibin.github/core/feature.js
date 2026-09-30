// PanelFeature: the base contract every top-bar feature implements.
// A feature contributes panel actors and menu sections to the shared
// ToolboxIndicator, and manages its own timers/signals between
// enable() and disable(). The extension toggles features at runtime
// via their gsettings switch key.

export class PanelFeature {
    /**
     * @param {{extension: Object, settings: Gio.Settings, clipboard?: Object}} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;
        // Managed by the extension when the enable-* switch changes;
        // true between enable() and disable().
        this.active = false;
    }

    // Stable feature identifier, e.g. 'vitals'.
    get id() {
        throw new Error('PanelFeature.id must be overridden');
    }

    // GSettings boolean key enabling this feature, e.g. 'enable-vitals'.
    get settingsKey() {
        throw new Error('PanelFeature.settingsKey must be overridden');
    }

    // Top-bar actors contributed by this feature (St widgets). The feature
    // owns their visibility. Return [] for features without panel presence.
    panelActors() {
        return [];
    }

    // Append this feature's menu sections to the shared dropdown `menu`.
    buildMenu(_menu) {}

    // Start sampling, timers and signal listeners. Called once per enable.
    enable() {}

    // Stop everything started in enable(). The indicator removes the UI;
    // the feature must not touch actors after this returns.
    disable() {}

    // Full teardown on extension disable. Default is disable().
    destroy() {
        this.disable();
    }
}
