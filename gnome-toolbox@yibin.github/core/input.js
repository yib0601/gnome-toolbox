// Shared virtual keyboard device.
//
// Mutter dispatches notify_keyval() on its input thread through an idle
// callback, so the virtual device must stay alive well past the dispatch.
// Destroying it right after notifying frees the device under the input
// thread (use-after-free -> SIGSEGV in notify_keyval_in_impl). One cached
// device is shared across the whole extension lifetime instead.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

let _virtualKeyboard = null;

export function getVirtualKeyboard() {
    if (_virtualKeyboard)
        return _virtualKeyboard;
    try {
        // GNOME 51: Clutter.get_default_backend() was removed; reach the
        // backend through the stage's Clutter.Context instead.
        const backend = Clutter.get_default_backend
            ? Clutter.get_default_backend()
            : global.stage.get_context().get_backend();
        const seat = backend.get_default_seat();
        _virtualKeyboard = seat.create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE);
    } catch (e) {
        log(`gnome-toolbox: could not create virtual keyboard: ${e.message}`);
        _virtualKeyboard = null;
    }
    return _virtualKeyboard;
}

// Drain any queued input-thread dispatch before releasing the device.
export function disposeVirtualKeyboard() {
    const device = _virtualKeyboard;
    _virtualKeyboard = null;
    if (!device)
        return;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        device.run_dispose();
        return GLib.SOURCE_REMOVE;
    });
}

export function getKeymap() {
    try {
        const backend = Clutter.get_default_backend
            ? Clutter.get_default_backend()
            : global.stage.get_context().get_backend();
        return backend.get_default_seat().get_keymap();
    } catch (e) {
        log(`gnome-toolbox: could not obtain keymap: ${e.message}`);
        return null;
    }
}
