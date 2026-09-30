#!/usr/bin/env bash
# Pack and install the gnome-toolbox extension.
set -euo pipefail
cd "$(dirname "$0")"

EXT="gnome-toolbox@yibin.github"
ZIP="${EXT}.shell-extension.zip"
rm -f "$ZIP"

# Syntax-check every top-level module before packing (ESM; shell caches
# modules, so a bad install only surfaces after a full logout/login).
if command -v node >/dev/null 2>&1; then
    for f in "$EXT"/*.js; do
        node --check "$f" || { echo "SYNTAX_FAIL: $f"; exit 1; }
    done
fi

# Recompile the settings schema so prefs and the panel placement keys land
# in the package.
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas --strict "$EXT/schemas" || { echo "SCHEMA_FAIL"; exit 1; }
fi

EXTRA=()
for f in vitals.js clipboardManager.js indicator.js interfaces-xml tools \
         appIndicator.js dbusMenu.js dbusProxy.js dbusUtils.js iconCache.js \
         indicatorStatusIcon.js interfaces.js logger.js pixmapsUtils.js \
         promiseUtils.js settingsManager.js statusNotifierWatcher.js \
         trayIconsManager.js util.js; do
    EXTRA+=(--extra-source="$f")
done

gnome-extensions pack --force "${EXTRA[@]}" "$EXT"
gnome-extensions install --force "$ZIP"
echo PACK_INSTALL_OK
echo "NOTE: GNOME 51 不热加载扩展，需注销重新登录后新代码才生效。"
