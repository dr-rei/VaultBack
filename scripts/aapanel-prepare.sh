#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 22 or newer in aaPanel first." >&2
  exit 1
fi

node -e "const major=Number(process.versions.node.split('.')[0]); if (major < 22) { console.error('Node.js 22 or newer is required. Found '+process.version); process.exit(1); }"

echo "Installing production dependencies needed to build Vaultback..."
npm ci
npm run build

mkdir -p data/backups
chmod 700 data data/backups

if [ ! -f .env ]; then
  cp .env.example .env
fi

if ! grep -Eq '^APP_ENCRYPTION_KEY=[^[:space:]]+$' .env; then
  encryption_key="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  if grep -q '^APP_ENCRYPTION_KEY=' .env; then
    sed -i "s/^APP_ENCRYPTION_KEY=.*/APP_ENCRYPTION_KEY=${encryption_key}/" .env
  else
    printf '\nAPP_ENCRYPTION_KEY=%s\n' "$encryption_key" >> .env
  fi
  echo "Generated a stable APP_ENCRYPTION_KEY in .env. Keep this value for redeployments."
fi

echo
echo "Vaultback is prepared. Review .env, then start it with:"
echo "  pm2 start ecosystem.config.cjs"
