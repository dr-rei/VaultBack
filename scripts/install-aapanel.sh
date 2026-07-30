#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${1:-/www/wwwroot/vaultback}"
shift || true
BASE_URL="https://raw.githubusercontent.com/dr-rei/VaultBack/main/scripts"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'Run this aaPanel installer as root so it can assign the project to the www user.' >&2
  exit 1
fi
if [[ "$APP_ROOT" != /* || "$APP_ROOT" == "/" ]]; then
  echo 'APP_ROOT must be an absolute application directory, not /.' >&2
  exit 1
fi
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
command -v sudo >/dev/null || { echo 'sudo is required.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Node.js 22 or newer is required.' >&2; exit 1; }
id www >/dev/null 2>&1 || { echo 'The aaPanel www user does not exist.' >&2; exit 1; }

mkdir -p "$APP_ROOT"
chown -R www:www "$APP_ROOT"
chown www:www "$TEMP_DIR"
sudo -u www -H env "PATH=$PATH" curl --fail --location --proto '=https' --tlsv1.2 "$BASE_URL/install-release.mjs" --output "$TEMP_DIR/install-release.mjs"
sudo -u www -H env "PATH=$PATH" node "$TEMP_DIR/install-release.mjs" --app-root "$APP_ROOT" --install-only "$@"
