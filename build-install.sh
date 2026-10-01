#!/usr/bin/env bash
# Pack and install the gnome-toolbox extension.
set -euo pipefail
cd "$(dirname "$0")"

EXT="gnome-toolbox@yibin.github"
ZIP="${EXT}.shell-extension.zip"
rm -f "$ZIP"

# Syntax-check every module before packing (ESM; shell caches modules, so a
# bad install only surfaces after a full logout/login).
if command -v node >/dev/null 2>&1; then
    while IFS= read -r -d '' f; do
        node --check "$f" || { echo "SYNTAX_FAIL: $f"; exit 1; }
    done < <(find "$EXT" -name '*.js' -print0)
fi

# Recompile the settings schema so prefs and the panel placement keys land
# in the package.
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas --strict "$EXT/schemas" || { echo "SCHEMA_FAIL"; exit 1; }
fi

# Layout: core/ shared infra, features/ own capabilities, tray/ ported
# appindicator subsystem, tools/ inside tray/. Pack by directory so new
# files are picked up without editing this list. Note: gnome-extensions
# pack only bundles extension.js, prefs.js and schemas/ automatically;
# every other root-level module needs an explicit extra-source entry.
EXTRA=(
    --extra-source=indicator.js
    --extra-source=core
    --extra-source=features
    --extra-source=icons
    --extra-source=tray
)

gnome-extensions pack --force "${EXTRA[@]}" "$EXT"
gnome-extensions install --force "$ZIP"

# Make sure the uuid is (re-)enabled; gnome-shell only re-runs the
# cached module, so changed code needs a logout/login to be re-imported
# (GJS caches ESM per URI; Wayland shell cannot be restarted in-place).
gsettings get org.gnome.shell enabled-extensions | grep -qF "$EXT" || \
    gsettings set org.gnome.shell enabled-extensions \
    "$(gsettings get org.gnome.shell enabled-extensions | sed "s/]$/, '$EXT']/")"

echo PACK_INSTALL_OK
echo "NOTE: 代码改动需注销重新登录后生效（Wayland 下 gnome-shell 无法原地重载模块）。"
