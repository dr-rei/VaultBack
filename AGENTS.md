# Repository Guidelines

## Project Context

VaultBack is a self-hosted database backup manager published at `https://github.com/dr-rei/VaultBack`. The application is a NestJS/Fastify backend and a vanilla JavaScript frontend served by the same Node.js process. It stores application state in SQLite under `DATA_DIR`, encrypts database and storage credentials at rest, and uses portable MariaDB-compatible client tools stored inside the application directory.

The latest published release is `v0.1.21`. Do not create or publish a new release unless the user explicitly requests it.

## Repository Structure

- `src/main.ts`: application bootstrap, host/protocol checks, rate limiting, static files, and error handling.
- `src/auth/`, `src/database/`, `src/storage/`, `src/backup/`, `src/system/`: backend feature boundaries.
- `src/common/`: shared filters, guards, validation, and cross-cutting behavior.
- `src/backup/backup.service.ts`: scheduling, dump/restore execution, rotation, downloads, retries, and live process state.
- `src/database/database.service.ts`: SQLite schema creation and migration-safe upgrades.
- `src/system/realtime.service.ts`: authenticated Server-Sent Events (SSE), not WebSockets. Topics include processes, backup runs, sessions, rate limits, updates, storage health, and downloads.
- `public/index.html`: shared application shell and route markup.
- `public/app.js`: routing, API calls, rendering, modals, sidebar, themes, SSE subscriptions, and UI state.
- `public/styles.css`: canonical light/dark responsive stylesheet. Do not reintroduce `redesign.css`.
- `scripts/`: release, deployment, reset, and update utilities.
- `docs/`: deployment, release, aaPanel, and terms documentation.
- `tools/`: platform-specific portable database clients; executable contents are ignored.
- `data/`: runtime SQLite database, encryption key, temporary files, and local backups. Never commit it.
- `dist/`: generated TypeScript output. Never hand-edit it.

## Multi-Source Schedule Model

Schedules retain legacy `database_connection_id` and `storage_target_id` columns for compatibility, while new selections use:

- `backup_job_connections(job_id, connection_id, database_names, position)`
- `backup_job_storages(job_id, storage_target_id, position)`

The schedule UI submits `connectionIds`, `storageTargetIds`, `databaseSelections`, and `databaseScope`. Database choices are searched and grouped by connection. A multi-source run executes every selected connection/storage pair sequentially. Run-level connection, database scope, database names, and storage target are recorded in `backup_runs`; history, download, restore, and rotation must use those run-level values rather than assuming the legacy job target.

When changing this flow, preserve migration behavior for existing single-source schedules and avoid losing `DATA_DIR` data.

## Development and Verification

Run from the repository root:

```text
npm ci
npm run start:dev
npm run typecheck
npm run build
node --check public/app.js
git diff --check
```

There is no lint or automated test script. For frontend work, use the in-app browser and inspect routes from top to bottom in both themes. Check modals, grouped selectors, search, pagination, toasts, SSE updates, focus states, mobile navigation, sticky layout, no horizontal overflow, and browser console errors. Do not clear runtime data during normal testing.

## Coding Conventions

Use two-space indentation, semicolons, single quotes, PascalCase classes, camelCase functions, and descriptive NestJS filenames. Keep feature boundaries intact. Validate request data at controller/service boundaries. In the frontend, use the existing `data-view` routing model, `esc()` for user-controlled HTML, cookie-based theme/sidebar preferences, and one canonical implementation per feature. Do not append duplicate function overrides to `public/app.js`.

## Security and Configuration

- Never commit `.env`, credentials, tokens, encryption keys, `data/`, dumps, or backup artifacts.
- Preserve both `DATA_DIR` and `APP_ENCRYPTION_KEY` across redeployments.
- `NODE_ENV=production` enables rate limiting and generic 500 responses. `RATE_LIMIT_PER_MINUTE` defaults to `800`; `MAX_LOGIN_SESSIONS_PER_USER=0` means unlimited.
- `APP_DOMAIN` restricts exact allowed hostnames in production. `APP_PROTOCOL` accepts `http`, `https`, or `both`; HTTPS requires certificate and key paths.
- Live SSE connections are authenticated and topic-filtered by role. Do not expose admin-only topics or credentials in snapshots/logs.
- Bundled tools are managed under `tools/<engine>/<platform>-<arch>/bin/`; do not reintroduce OS `PATH` dependency or plaintext credential logging.
- The GUI restart action sends a graceful termination signal and needs PM2, aaPanel, Docker, or systemd to relaunch the process. Plain `npm start` will not self-restart.
- Treat `npm run reset-data` as destructive and require explicit confirmation before using it on real data.

## Release and Deployment

The release workflow `.github/workflows/release.yml` runs on tags matching `v*.*.*`, verifies the tag against `package.json`, builds Linux x64 and Windows x64 archives, creates `latest.json`, and publishes a GitHub release. Update both `package.json` and `package-lock.json`, run verification, commit with a conventional message, create the matching tag, and push the branch and tag only when authorized.

For aaPanel, use `docs/AA_PANEL.md` and `scripts/install-aapanel.sh`. The aaPanel installer is install-only: it downloads and verifies the release, preserves `.env`/`data`/`tools`, installs dependencies as the `www` user, and builds the app; PM2 start/stop/restart remains controlled by aaPanel’s GUI.

Use commit prefixes such as `feat:`, `fix:`, `refactor:`, and `docs:` followed by an imperative description. Keep changes narrowly scoped and document new environment variables, migrations, and restart requirements.
