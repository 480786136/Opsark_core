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
export OPSARK_PLATFORM_URL="${OPSARK_PLATFORM_URL:-https://zgspace.cn}"
target="${1:-}"
build_args=(build --bundles app,dmg)
if [[ -n "$target" ]]; then
  if [[ "$target" != "aarch64-apple-darwin" && "$target" != "x86_64-apple-darwin" ]]; then
    echo "Unsupported macOS target: $target" >&2
    exit 1
  fi
  if ! rustup target list --installed | grep -qx "$target"; then
    echo "Rust target is not installed. Run: rustup target add $target" >&2
    exit 1
  fi
  build_args+=(--target "$target")
fi
npm run tauri -- "${build_args[@]}"

bundle_root="$project_root/src-tauri/target/${target:+$target/}release/bundle"
echo "macOS package build completed. Output: $bundle_root"
find "$bundle_root" -maxdepth 3 \( -name '*.app' -o -name '*.dmg' \) -print
