#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 22 or newer in aaPanel first." >&2
  exit 1
fi

node -e "const major=Number(process.versions.node.split('.')[0]); if (major < 22) { console.error('Node.js 22 or newer is required. Found '+process.version); process.exit(1); }"

if [ -f tsconfig.json ] && [ -d src ]; then
  echo "Installing dependencies and building VaultBack from source..."
  npm ci
  npm run build
elif [ -f dist/main.js ]; then
  echo "Preparing the prebuilt VaultBack release archive..."
  npm ci --omit=dev --ignore-scripts
else
  echo "This directory is neither a source checkout nor a compiled VaultBack release." >&2
  echo "Expected src/ and tsconfig.json, or dist/main.js." >&2
  exit 1
fi

mkdir -p data/backups
chmod 700 data data/backups

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
  else
    cat > .env <<'ENV_FILE'
NODE_ENV=development
APP_DOMAIN=localhost,127.0.0.1
APP_PROTOCOL=http
PORT=3010
HOST=127.0.0.1
DATA_DIR=./data
RATE_LIMIT_PER_MINUTE=800
MAX_LOGIN_SESSIONS_PER_USER=0
APP_ENCRYPTION_KEY=
ALLOW_ANY_LOCAL_PATH=false
ENV_FILE
  fi
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
