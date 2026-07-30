#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${1:-/www/wwwroot/vaultback}"
shift || true
BASE_URL="https://raw.githubusercontent.com/dr-rei/VaultBack/main/scripts"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Node.js 22 or newer is required.' >&2; exit 1; }
curl --fail --location --proto '=https' --tlsv1.2 "$BASE_URL/install-release.mjs" --output "$TEMP_DIR/install-release.mjs"
node "$TEMP_DIR/install-release.mjs" --app-root "$APP_ROOT" "$@"
