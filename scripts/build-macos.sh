#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS application and DMG packages must be built on macOS." >&2
  exit 1
fi

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
icon_path="$project_root/src-tauri/icons/icon.icns"

if [[ ! -s "$icon_path" ]]; then
  echo "macOS icon is missing or empty: $icon_path" >&2
  exit 1
fi

cd "$project_root"
npm run tauri -- build --bundles app,dmg

bundle_root="$project_root/src-tauri/target/release/bundle"
echo "macOS package build completed. Output: $bundle_root"
find "$bundle_root" -maxdepth 3 \( -name '*.app' -o -name '*.dmg' \) -print
