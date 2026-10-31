#!/usr/bin/env bash
# Extract the GNOME Shell JS sources of the CURRENTLY INSTALLED gnome-shell
# into shell-src/, so extension work is written against the real local API
# instead of stale knowledge. Re-run after every gnome-shell upgrade.
set -euo pipefail
cd "$(dirname "$0")"

VER="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"

# The .so is NOT named after the shell version: the suffix is the Shell/St API
# version (libshell-18.so is what gnome-shell 50.x ships), and it drifts on its
# own schedule. Globbing is the only reliable rule; the shell version goes into
# SHELL-VERSION as provenance only.
LIB="$(ls -1 /usr/lib64/gnome-shell/libshell-[0-9]*.so 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$LIB" ] && [ -f "$LIB" ] || {
    echo "MISS: /usr/lib64/gnome-shell/libshell-[0-9]*.so 不存在"; exit 1; }

# gresource lives in glib2-devel, which a plain Workstation install may not
# have; flatpak runtimes ship the same tool, so fall back to those.
GRESOURCE="$(command -v gresource || true)"
if [ -z "$GRESOURCE" ]; then
    GRESOURCE="$(ls -1 /var/lib/flatpak/runtime/org.gnome.Platform/*/*/*/files/bin/gresource 2>/dev/null \
        | sort -V | tail -1 || true)"
fi
[ -n "$GRESOURCE" ] && [ -x "$GRESOURCE" ] || {
    echo "MISS: gresource（sudo dnf install glib2-devel 后重试）"; exit 1; }

rm -rf shell-src
mkdir -p shell-src

count=0
while IFS= read -r path; do
    # /org/gnome/shell/ui/xxx.js -> shell-src/ui/xxx.js
    rel="${path#/org/gnome/shell/}"
    out="shell-src/$rel"
    mkdir -p "$(dirname "$out")"
    "$GRESOURCE" extract "$LIB" "$path" > "$out"
    count=$((count + 1))
done < <("$GRESOURCE" list "$LIB" | grep '^/org/gnome/shell/' | grep '\.js$')

echo "$VER" > shell-src/SHELL-VERSION
echo "SHELL_SRC_OK: $count files -> shell-src/ (gnome-shell $VER, $(basename "$LIB"))"
