#!/usr/bin/env bash
# Extract the GNOME Shell JS sources of the CURRENTLY INSTALLED gnome-shell
# into shell-src/, so extension work is written against the real local API
# instead of stale knowledge. Re-run after every gnome-shell upgrade.
set -euo pipefail
cd "$(dirname "$0")"

VER="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"
LIB="/usr/lib64/gnome-shell/libshell-${VER}.so"
[ -f "$LIB" ] || { echo "MISS: $LIB（gnome-shell 升级后需先确认新库名）"; exit 1; }

rm -rf shell-src
mkdir -p shell-src

count=0
while IFS= read -r path; do
    # /org/gnome/shell/ui/xxx.js -> shell-src/ui/xxx.js
    rel="${path#/org/gnome/shell/}"
    out="shell-src/$rel"
    mkdir -p "$(dirname "$out")"
    gresource extract "$LIB" "$path" > "$out"
    count=$((count + 1))
done < <(gresource list "$LIB" | grep '^/org/gnome/shell/' | grep '\.js$')

echo "$VER" > shell-src/SHELL-VERSION
echo "SHELL_SRC_OK: $count files -> shell-src/ (gnome-shell $VER)"
