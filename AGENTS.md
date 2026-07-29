# Repository Guidelines

## Project Overview

VaultBack is a self-hosted database-backup manager. NestJS with Fastify serves both the JSON API and the static vanilla-JavaScript GUI from one Node.js process. SQLite-backed application data and encrypted credentials live under `DATA_DIR`; the native `mysql2` driver handles connection tests and database discovery, while bundled MySQL/MariaDB clients create dumps and restores.

## Repository Layout

- `src/`: backend feature modules: `auth`, `database`, `storage`, `backup`, and `system`.
- `src/common/`: cross-cutting filters and shared backend behavior, including production-safe error responses.
- `public/index.html`: shared GUI shell and view markup.
- `public/app.js`: frontend state, routing, API calls, rendering, modals, sidebar, and live process/session polling.
- `public/styles.css`: canonical visual system for light/dark themes and responsive layouts. Do not reintroduce `redesign.css`.
- `scripts/`: deliberate operational commands (`reset-data.mjs`, `reset-admin.mjs`).
- `tools/`: optional portable MySQL/MariaDB client layouts; executable binaries are ignored.
- `data/`: runtime SQLite database, encryption key, temporary files, and local backups; never commit or expose it.
- `dist/`: generated TypeScript output; do not hand-edit.

## Development Commands

Run from the repository root:

```text
npm ci                 # install package-lock.json exactly
npm run start:dev      # watch-mode development server
npm run typecheck      # TypeScript validation without output
npm run build          # compile src/ into dist/
npm start              # run dist/main.js
npm run reset-data     # destructive local first-install reset; confirm scope first
npm run reset-admin    # interactively replace the oldest administrator
```

There is currently no lint or automated test script. Do not add a new dependency merely to satisfy a review; use the existing typecheck/build commands and perform UI verification in the in-app browser.

## Implementation Conventions

Use two-space indentation, semicolons, single quotes, PascalCase classes, camelCase functions, and descriptive NestJS filenames such as `backup.service.ts`. Keep backend feature boundaries intact. Validate request data at the controller/service boundary and use existing DTO/schema patterns.

The frontend is a classic browser script, not a framework component tree. Preserve the existing `data-view` route model, cookie-based theme/sidebar preferences, modal behavior, and API error handling. Escape user-controlled values with the existing `esc()` helper before inserting HTML. When cleaning `public/app.js`, remove obsolete duplicate declarations instead of appending another override: later duplicate function declarations currently win by source order and can hide bugs. Keep one canonical implementation and one initialization path for each feature.

## Security and Data Safety

- Never commit `.env`, `data/`, database dumps, backup artifacts, credentials, tokens, or encryption keys.
- Preserve both the same `DATA_DIR` and `APP_ENCRYPTION_KEY` during redeployment. Losing either can make stored credentials unreadable.
- Never log plaintext database/storage credentials or return them through the GUI/API.
- `NODE_ENV=production` enables rate limiting and sanitizes 500 responses to `Internal server error`; development may expose diagnostic messages. `RATE_LIMIT_PER_MINUTE` defaults to `800`, and `MAX_LOGIN_SESSIONS_PER_USER=0` means unlimited.
- `APP_DOMAIN` is required in production and accepts comma-separated exact hostnames; unexpected `Host` headers receive `421`. `APP_PROTOCOL` accepts `http`, `https`, or `both`; HTTPS modes require `HTTPS_CERT_FILE` and `HTTPS_KEY_FILE`, and `both` redirects HTTP to HTTPS.
- The GUI restart action sends a graceful termination signal and relies on PM2, aaPanel, Docker, or systemd to relaunch the process. Do not describe it as a self-relaunch when running plain `npm start`.
- Do not run reset commands against a real deployment without explicit confirmation and a verified backup.

## Database Client and Deployment Rules

VaultBack does not require a second database server. It uses only matching portable tools under `tools/<engine>/<platform>-<arch>/bin/` inside the application directory. The guided installer downloads and verifies the MariaDB client pack into `tools/mariadb/<platform>-<arch>/`; its compatible tools serve both MySQL and MariaDB connections. System installations, `PATH`, and `DB_CLIENT_BINARY`/`DB_DUMP_BINARY` overrides are intentionally ignored. Deployment-specific instructions belong in `README.md`, `AA_PANEL.md`, or `tools/README.md`.

## Verification Checklist

Before handing off changes, run:

```text
node --check public/app.js
npm run typecheck
npm run build
git diff --check
```

For backend changes, test authentication, authorization, error handling, scheduling, and the affected API. For frontend changes, use the in-app browser and inspect every relevant route from top to bottom in light and dark themes. Check modals, toasts, tables, pagination, focus states, mobile drawer/sidebar behavior, live polling, refresh persistence, and unknown-route 404 behavior. Confirm no horizontal overflow, missing stylesheet requests, or console errors. Never clear runtime data as part of a normal UI test.

## Change and Review Guidelines

Keep changes narrowly scoped; do not alter backup, authentication, encryption, or database behavior during a visual-only task. Document new environment variables and restart/migration requirements. UI changes should include screenshots or a clear route/viewport test summary. Prefer commit messages such as `feat:`, `fix:`, `refactor:`, and `docs:` followed by an imperative description.
