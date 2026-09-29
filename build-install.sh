#!/usr/bin/env bash
# Pack and install the gnome-toolbox extension.
set -euo pipefail
cd "$(dirname "$0")"

EXT="gnome-toolbox@yibin.github"
ZIP="${EXT}.shell-extension.zip"
rm -f "$ZIP"

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
