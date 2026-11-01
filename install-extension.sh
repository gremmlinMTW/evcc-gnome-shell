#!/usr/bin/env bash
set -euo pipefail

uuid='evcc-topbar@gremmlinmtw.github.com'
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

if ! command -v gnome-extensions >/dev/null 2>&1; then
    printf '%s\n' 'Error: gnome-extensions is not installed or not on PATH.' >&2
    exit 1
fi

gnome-extensions pack --force --extra-source="$script_dir/webapp.js" --extra-source="$script_dir/LICENSE" --out-dir "$temp_dir" "$script_dir"
gnome-extensions install --force "$temp_dir/$uuid.shell-extension.zip"

if gnome-extensions list --enabled | grep -Fxq "$uuid"; then
    gnome-extensions disable "$uuid"
fi
gnome-extensions enable "$uuid"

printf 'Installed and enabled %s.\n' "$uuid"
