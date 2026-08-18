# VaultBack

> A self-hosted MySQL and MariaDB backup manager for scheduled, encrypted, and verifiable database backups.

VaultBack is a web-based database backup solution for teams and administrators who need reliable backup automation under their own control. It provides a browser GUI, JSON API, scheduler, portable database client tools, storage integrations, backup history, and restore workflows in one Node.js application.

Unlike a hosted backup service, VaultBack runs on your own server and sends backup archives to destinations that you configure. It does not require a separate database server for its own control-plane data: users, schedules, encrypted connection settings, sessions, audit records, and backup history are stored in an automatically managed SQLite database.

## Why use VaultBack?

VaultBack is designed for self-hosted applications, small teams, developers, and system administrators who want a practical MySQL/MariaDB backup system without building a collection of cron jobs and shell scripts. It makes routine backup operations visible and manageable from a single interface while keeping database credentials and operational data on your infrastructure.

## Core features

- **Automated database backups:** create cron-based schedules with time zones, retry policies, overlap handling, and retention rotation.
- **Flexible backup scope:** back up every database visible to a connection or choose specific databases from a searchable, connection-grouped list.
- **Multiple archive layouts:** create a single SQL dump, one SQL file per database, or one SQL file per table inside a ZIP archive.
- **Compression and protection:** use GZIP or ZIP compression, optional AES-256-GCM backup-file encryption, checksums, and archive verification.
- **Local and remote storage:** deliver backups to local folders, FTP/FTPS, WebDAV/Synology, Google Drive, OneDrive, or S3-compatible storage, with a separate folder for each schedule. S3 Object Lock can be verified and used for provider-enforced COMPLIANCE retention.
- **Recovery workflows:** download verified backup files or restore them over an existing database or into a new database name.
- **Recovery Assurance:** schedule isolated restore rehearsals, record RPO/RTO evidence, inspect PITR/binlog readiness, capture raw binlog files with checksums, follow recovery runbooks, and review backup-policy findings before an incident. Automatic binlog application/PITR restore is not claimed as supported yet.
- **Resilience foundation:** keep an administrator-only registry of enrolled VaultBack installations with revocable, hashed one-time enrollment tokens.
- **Operations visibility:** monitor backup progress, live process logs, storage health, stale artifacts, active sessions, API rate-limit usage, and audit events.
- **Access control:** use administrator, operator, and viewer roles with protected administrator actions and encrypted credentials at rest.
- **Portable database tools:** use application-managed MySQL/MariaDB client utilities instead of depending on database commands installed in the operating system `PATH`.

## Security and deployment at a glance

Database and storage credentials are encrypted before they are stored. The encryption key is preserved separately from the SQLite database, so redeployments must retain both the configured `APP_ENCRYPTION_KEY` or `data/.encryption-key` and the application data directory. Production mode supports rate limiting, safer error responses, host validation, and HTTPS configuration.

VaultBack can run locally or under PM2, aaPanel, Docker, systemd, or another process supervisor. Versioned release archives and an administrator-controlled in-app update workflow are available for deployments that should not use `git pull`.

## Start here

| Goal | Recommended guide |
|---|---|
| Run locally for development | Follow [the local development quick start](#quick-start) |
| Deploy on aaPanel with PM2 | Follow [the aaPanel and PM2 deployment guide](docs/AA_PANEL.md) |
| Publish releases and update from the GUI | Follow [the release and in-app update guide](docs/RELEASES.md) |
| Deploy with Docker | Follow [the Docker deployment section](#docker-deployment) |
| Deploy on Linux with systemd | Follow [the systemd deployment section](#linux-deployment-with-systemd) |
| Understand usage restrictions | Read [the VaultBack terms of use](docs/TERMS_OF_USE.md) |
| Prepare portable database clients | Read [the portable database-tools guide](tools/README.md) |

## Documentation map

- [Main deployment and operations documentation](#deployment-requirements)
- [aaPanel and PM2 deployment guide](docs/AA_PANEL.md)
- [Versioned releases and in-app updates](docs/RELEASES.md)
- [Portable database-tools guide](tools/README.md)
- [Terms of use and third-party component notice](docs/TERMS_OF_USE.md)
- [Recovery Assurance, PITR, and resilience operations](docs/RECOVERY_ASSURANCE.md)
- [Security threat model](docs/THREAT_MODEL.md)

## Architecture and persistent data

VaultBack runs as one Node.js process:

| Component | Location | Responsibility |
|---|---|---|
| Browser GUI | `public/` | Vanilla JavaScript interface, routing, forms, live process views, and theme preferences. |
| API and scheduler | `src/` → `dist/` | NestJS/Fastify API, authentication, scheduling, backup execution, storage adapters, and migrations. |
| Control-plane database | `data/vaultback.sqlite` | Users, schedules, encrypted settings, sessions, audit records, and backup history. |
| Encryption key | `data/.encryption-key` | Automatically generated key when `APP_ENCRYPTION_KEY` is not set. |
| Local artifacts | `data/backups/` | Default local backup destination; files are ignored by Git. |
| Portable clients | `tools/` | MySQL/MariaDB command-line clients used for dumps and restores. |

The SQLite database is created and migrated automatically on startup. A separate MySQL or MariaDB server is not required for VaultBack. Connection tests and database discovery use the native `mysql2` driver; bundled command-line clients are used for logical dumps and restores.

## Quick start

For a local development or evaluation install:

~~~powershell
npm ci
Copy-Item .env.example .env
npm run build
npm start
~~~

Open [the local VaultBack application](http://127.0.0.1:3010). On first login, create the administrator, use **Settings → Database tools** to install the supported portable client pack, then follow the first-time setup flow.

For production, set a stable `APP_ENCRYPTION_KEY`, configure `APP_DOMAIN`, use HTTPS or an HTTPS reverse proxy, and run VaultBack under PM2, systemd, Docker, or another supervisor.

## Reset to first-install state

Stop the running app, then remove all VaultBack application data with:

~~~bash
npm run reset-data
~~~

The command lists the targets and asks you to type `RESET`. For unattended use, add `-- --force`:

~~~bash
npm run reset-data -- --force
~~~

It removes the SQLite control database, encrypted key file, pending imports, local backup artifacts, and temporary files. It preserves the project, dependencies, and `.env`. Use `--dry-run` to preview the targets without removing anything:

~~~bash
npm run reset-data -- --dry-run
~~~

## Reset the administrator account

If the administrator username or password is lost, stop the running app and run:

~~~bash
npm run reset-admin
~~~

The command prompts for a new username and password, then asks you to type `RESET ADMIN`. It changes only the oldest administrator account, logs out all existing sessions, and preserves database connections, schedules, storage targets, and backup history. For controlled non-interactive use, `RESET_ADMIN_USERNAME` and `RESET_ADMIN_PASSWORD` may be supplied as environment variables together with `-- --force`; avoid storing the password in shell history or permanent environment configuration.

## Feature details

- Scheduled MySQL/MariaDB backups with all-database or live database checklist selection.
- GZIP or ZIP compression, per-database and per-table ZIP layouts, selectable views, stored procedures/functions, triggers, and scheduled events, optional AES-256-GCM backup-file encryption, retention rotation, checksums, and archive/content verification.
- Local, FTP/FTPS, WebDAV/Synology, Google Drive, and OneDrive destinations. Each new schedule stores its backups in a dedicated `schedule-<schedule-id>` folder within the selected target, so separate schedules never mix their files. Existing backups created before this behavior remain supported from the target root.
- Google and Microsoft OAuth refresh-token support for unattended cloud schedules.
- Backup success/failure/capacity notifications through Discord, Telegram, or HTTPS webhooks.
- Storage capacity monitoring, scheduled storage health checks, stale-backup alerts, retry and overlap policies, server-side search and pagination for databases, storage targets, schedules, backup history, and users, plus per-schedule stored-backup lists, verification reports, retry actions, and safe configuration export. List queries return only the requested page, with a 25-item default and 50/100-item choices, so large installations remain responsive.
- Restore verification checks that destination databases exist and reports the restored table count. Administrators can review the paginated audit log and storage health status from Settings.
- Automatic retry attempts can be configured per schedule (0–10 attempts, delay 30 seconds–24 hours). Overlapping scheduled runs default to skip; choosing queue runs one pending overlap after the active run finishes.
- The encrypted disaster-recovery export includes the control-plane database, encryption key, application version, runtime metadata, and recovery instructions. Backup files remain separate and must be copied from their storage target.
- Administrator, operator, and viewer roles, plus a guided first-time setup flow. Administrators can review active sessions and per-IP API rate-limit usage, which refreshes every two seconds while the page is open. The first administrator can revoke all sessions; other administrators can revoke operator/viewer sessions only. `MAX_LOGIN_SESSIONS_PER_USER` can also limit concurrent logins per account.

Archive verification decrypts/decompresses the artifact and checks for recognizable SQL dump content. Restore verification runs after an administrator confirms a restore and checks destination connectivity, database existence, and table counts. `BACKUP_STALE_AFTER_HOURS` controls the default stale-backup alert threshold (26 hours).

## Deployment requirements

### Required

- Node.js 22 or newer for a native deployment.
- A writable application data directory.
- The matching MySQL or MariaDB command-line client pack:
  - `mysql`/`mysqldump` for MySQL connections.
  - `mariadb`/`mariadb-dump` for MariaDB connections.

Client tools are managed inside the application directory under `tools/`. VaultBack does not use database clients installed system-wide, found on `PATH`, or supplied through binary-path environment variables.

### Not required

- A separate database server for VaultBack.
- Redis.
- Visual Studio or a native C++ build toolchain. The control-plane database uses SQL.js.

## Choose a deployment mode

### aaPanel GUI values

After running the aaPanel install-only command, configure the Node.js project in aaPanel with these values. The project must run as `www`; do not start it as `root`.

#### PM2 Project tab (recommended)

| aaPanel field | Value |
|---|---|
| Project Name | `vaultback` |
| Node Version | Node.js 22 or newer |
| Startup File | `dist/main.js` |
| Run Directory | `/www/wwwroot/vaultback` (use your exact path and letter case) |
| Cluster | `1` |
| Memory Limit | `512 MB` or `1024 MB` |
| Auto Restart | On |
| Package Manager | `npm` |
| Do not install `node_module` | Checked when the installer already ran `npm ci` |
| Run User | `www` |

Keep the Environment Variables field empty when using `.env` in the project directory. Never paste `APP_ENCRYPTION_KEY`, database passwords, storage tokens, or other secrets into screenshots or Git. After confirming the PM2 project, use **Start** or **Restart** in aaPanel; the installer itself does not control PM2.

#### Default Project tab (alternative)

| aaPanel field | Value |
|---|---|
| Path | `/www/wwwroot/vaultback` |
| Name | `vaultback` |
| Run option | `npm start` |
| Port | `3010` (or the `PORT` value in `.env`) |
| User | `www` |
| Node | Node.js 22 or newer |

PM2 Project mode is preferred because aaPanel provides clearer restart, logs, memory, and boot-persistence controls. When aaPanel exposes a **Config File** field, select `ecosystem.config.cjs`; it writes PM2 stdout and stderr to `data/logs/vaultback-out.log` and `data/logs/vaultback-error.log`. The `data/` directory is runtime data and is ignored by Git. The updater reports progress in `data/update-status.json` and detailed updater commands in `data/logs/update.log`. With a reverse proxy, keep VaultBack bound to `127.0.0.1` and proxy the domain to the configured application port.

### Portable client deployment

VaultBack can discover client binaries inside the application directory. Use this layout:

~~~text
tools/
  mysql/
    win32-x64/bin/mysql.exe
    win32-x64/bin/mysqldump.exe
  mariadb/
    win32-x64/bin/mariadb.exe
    win32-x64/bin/mariadb-dump.exe
~~~

Use the matching `<platform>-<arch>` directory for other systems, such as `linux-x64`.

The repository does not include third-party binaries. Obtain and redistribute MySQL or MariaDB clients only under their applicable license terms. The repository includes the folder layout and placeholders; copy the matching standalone binaries into the folders before deployment. See [the portable database-tools guide](tools/README.md) and [the third-party component terms](docs/TERMS_OF_USE.md).

### Docker deployment option

The included Dockerfile provides the Node runtime and certificates. On first setup, use the guided installer to download the verified client pack into the container’s `/app/tools/` directory; no host database client is used.

## Configuration

Copy the example configuration before starting a native deployment:

~~~powershell
Copy-Item .env.example .env
~~~

Important settings:

| Variable | Default | Purpose |
|---|---|---|
| `APP_DOMAIN` | local hosts in development; required in production | Comma-separated exact hostnames accepted by VaultBack. Other `Host` headers receive `421 Host not allowed`. |
| `APP_PROTOCOL` | `http` | `http`, `https`, or `both`. `both` serves HTTPS and redirects HTTP to HTTPS. |
| `PORT` | `3010` | Main application port. For `http` or `https`, this is the selected protocol’s port. In `both` mode, HTTP uses `HTTP_PORT` and HTTPS uses `HTTPS_PORT`. |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only when a reverse proxy or trusted network protects the port. |
| `HTTP_PORT` | `PORT` | HTTP redirect port used only by `APP_PROTOCOL=both`. |
| `HTTPS_PORT` | `3443` | HTTPS application port used only by `APP_PROTOCOL=both`. |
| `HTTPS_CERT_FILE` | unset | PEM certificate/full-chain path required for `https` or `both`. |
| `HTTPS_KEY_FILE` | unset | PEM private-key path required for `https` or `both`. |
| `DATA_DIR` | `./data` | Directory containing SQLite, the encryption key, temporary files, and default local backups. |
| `APP_ENCRYPTION_KEY` | generated automatically | Stable secret used to encrypt stored credentials. Set this explicitly in production. |
| `DB_CLIENT_BINARY`, `DB_DUMP_BINARY`, and engine-specific binary variables | ignored | Retained only for compatibility with older `.env` files; VaultBack uses the application-managed `tools/` directory instead. |
| `ALLOW_ANY_LOCAL_PATH` | `false` | Keep `false` unless arbitrary local destination paths are intentionally required. |
| `NODE_ENV` | `development` behavior when unset | Set to `production` to enable production protections. Development exposes detailed 500-level error messages for debugging. |
| `RATE_LIMIT_PER_MINUTE` | `800` | Production only. Maximum normal API requests per client IP per minute. Login and setup use a separate limit of 10 attempts per 15 minutes. |
| `MAX_LOGIN_SESSIONS_PER_USER` | `0` | Maximum active login sessions per user. `0` means unlimited. When positive, the oldest sessions are removed before a new login is created. |
| `SWAGGER_ENABLED` | `false` | Set to `true` only when an administrator needs the protected OpenAPI UI at `/api/docs`. It is disabled by default. |
| `UPDATE_MANIFEST_URL` | GitHub release feed | Optional HTTPS URL for a custom `latest.json` release manifest. Leave unset to use the public VaultBack release feed. |
| `UPDATE_CHANNEL` | `stable` | Release channel label shown in the administrator update panel. |
| `UPDATE_PM2_APP` | unset | PM2 process name used by the in-app updater. Set this to `vaultback` for aaPanel/PM2 deployments. |

For direct HTTPS, set `APP_PROTOCOL=https`, `PORT` to the HTTPS port, and provide the certificate and private-key files. For `APP_PROTOCOL=both`, VaultBack serves HTTPS on `HTTPS_PORT` and returns a permanent redirect from `HTTP_PORT`; it does not serve the GUI over plaintext HTTP. With a reverse proxy, keep `APP_PROTOCOL=http`, bind VaultBack to localhost, and terminate TLS at the proxy.

Rate limiting is disabled when `NODE_ENV` is anything other than `production`. In production, static frontend files are not rate-limited, normal API requests use `RATE_LIMIT_PER_MINUTE`, and login/setup requests use the stricter authentication bucket. The administrator-only Sessions & security page displays the current per-IP usage, remaining quota, reset time, and active sessions. Production 500-level responses always return `Internal server error`; the full error is logged by the server. Restart VaultBack after changing these values.

The first administrator can change `NODE_ENV` from **Settings → Environment**. The selected value is written to `.env` and can be saved for the next restart or applied immediately through the configured supervisor. The `.env` value is authoritative for VaultBack, so a stale `NODE_ENV` saved in a PM2 environment does not override the GUI selection. Production mode requires `APP_DOMAIN` and enables rate limiting plus sanitized 500-level responses; development mode is intended for trusted troubleshooting only.

Live operational data uses the authenticated server-sent event stream at `/api/events`, not a repeating browser API poll. The stream is excluded from the normal API bucket after session authentication, is limited to five connections per user and twenty per source IP, sends heartbeats, and automatically closes when the session is revoked. Operators and viewers receive only process, backup-run, and storage-health topics; administrator-only sessions, per-IP rate-limit usage, and update topics are filtered at the server. If aaPanel/Nginx is used, disable proxy buffering for the VaultBack location so events are delivered immediately.

### Operations and API diagnostics

- `GET /api/health` is an unauthenticated liveness check for supervisors and reverse proxies.
- `GET /api/health/ready` is an unauthenticated readiness check. It verifies SQLite access, encryption-key health, and critical disk capacity and returns a standard health status response.
- `GET /api/health/details` remains an authenticated diagnostic endpoint for the GUI and includes dependency/tool details.
- Every request receives an `X-Request-Id` response header. Include that value when correlating a user-visible error with server logs.
- Set `SWAGGER_ENABLED=true` temporarily to expose administrator-only API documentation at `/api/docs`. The docs and JSON document endpoint return `404` to unauthenticated or non-administrator callers; disable the setting again after troubleshooting.

The global validation pipe transforms supported values, rejects unknown fields, and validates DTO-backed write requests. In production, validation and 500-level responses intentionally avoid returning internal implementation details.

### Versioned releases and in-app updates

The server checks for new releases every 15 minutes and broadcasts update status to authenticated administrator browsers over the event stream. The browser no longer polls the update endpoint on a timer.

This server-side check supersedes the legacy browser-tab polling wording in older deployment notes below.

Release builds are published as versioned archives rather than Git working trees. The administrator can open **Settings → Software updates** to check the HTTPS release manifest, review the changelog for every release newer than the installed version, and install the latest verified package. After login, VaultBack checks for updates automatically and repeats the check every 15 minutes while the browser tab is visible. When a newer release is found, an update indicator appears in the global top bar and links directly to the Software updates section. The updater verifies the manifest artifact URL and SHA-256 checksum, preserves `data/`, `.env`, and `tools/`, runs `npm ci --omit=dev`, restarts the configured PM2 process, and checks the health endpoint. A failed install is rolled back to the previous application files. Configure `UPDATE_PM2_APP=vaultback` for aaPanel/PM2; the updater also falls back to `vaultback` when this variable is omitted. A plain `npm start` process cannot relaunch itself after the graceful shutdown. See [docs/RELEASES.md](docs/RELEASES.md) for the release server, manifest format, release-history field, GitHub Actions workflow, and migration precautions.

For a new aaPanel install or a server-side upgrade without Git, use the aaPanel-specific install-only bootstrap. It installs files as `www` and leaves PM2 under aaPanel GUI control:

~~~bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/dr-rei/VaultBack/main/scripts/install-aapanel.sh \
  | sudo bash -s -- /www/wwwroot/vaultback
~~~

Windows administrators can download and run `scripts/install-release.ps1` from PowerShell. The general installer downloads the latest platform archive, verifies SHA-256, preserves `data/`, `.env`, and `tools/`, installs production dependencies, and starts or restarts PM2. Node.js 22+, PM2, and the platform's standard archive tools are still required; first-time `.env` and database-tool setup remain separate configuration tasks. Review the script or pin its URL to a reviewed release tag when required by deployment policy.

### Restarting from the GUI

Administrators can open **Settings** and choose **Restart application**. VaultBack returns an accepted response, waits briefly, and then sends itself `SIGTERM` for a graceful shutdown. The button is therefore a supervisor-triggered restart, not a self-relaunching Node process. It works with the included PM2 configuration, aaPanel/PM2, Docker with `--restart unless-stopped`, or systemd with `Restart=on-failure`. A plain `node dist/main.js` or `npm start` process will stop and must be started again manually if no process manager is supervising it. Do not use the control during an active backup.

Generate a stable encryption secret with:

~~~powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
~~~

Then place the result in `.env`:

~~~env
APP_ENCRYPTION_KEY=replace-with-the-generated-value
~~~

Do not configure Laragon or other operating-system client paths. The bundled tools are selected from the application directory:

~~~text
tools/mariadb/win32-x64/bin/mysql.exe
tools/mariadb/win32-x64/bin/mysqldump.exe
~~~

On first setup, open **Settings → Database tools** and choose **Set up database tools**. The verified package is downloaded into `tools/mariadb/<platform>-<arch>/`; operating-system installations and `PATH` entries are ignored.

VaultBack passes `--no-defaults` to managed MySQL/MariaDB commands. This prevents incompatible entries in global option files from overriding values entered in the GUI.

## Export and migration

Open **Settings** as an administrator.

- **Export safe configuration** downloads a readable JSON file containing connection, storage-target, and schedule metadata without passwords, tokens, storage configuration secrets, or encrypted secret values. Use it as a reference when rebuilding another installation; credentials must be entered again.
- **Export encrypted package** creates a password-protected JSON package containing the VaultBack SQLite control-plane database and the application encryption key. The export password must contain at least 12 characters. Keep this package and password separate from each other.
- **Import encrypted package** uploads the package and stages it for the next restart. After the success message, stop and start VaultBack, then sign in using the users contained in the imported database.

The encrypted package migrates VaultBack configuration, users, schedules, notification settings, encrypted database/storage credentials, audit history, and backup-run history. It does not include local backup artifacts under `data/backups`; copy those separately or download them from their configured storage destination. If the destination server sets `APP_ENCRYPTION_KEY`, it must match the key from the source installation, or it must be removed so VaultBack can use the imported `data/.encryption-key`.

Never email or upload an encrypted package together with its password. A wrong password is rejected without staging an import. The running database is never replaced immediately; the staged files are applied only during application startup.

## Restoring a backup

Open **Backup history** and choose **Restore** on a successful backup. Restore is administrator-only. Select the destination database connection, then choose one of these modes:

- **Restore original database names**: restores the dump’s original database names and requires an explicit overwrite acknowledgment. Use this only after confirming the destination and taking a current backup.
- **Restore as a new database name**: available when the backup contains exactly one database. Enter a name using letters, numbers, and underscores. If that name already exists, VaultBack requires the same overwrite acknowledgment.

The restore process downloads the artifact from its configured storage target, decrypts/decompresses it when required, and passes it to the selected bundled MySQL/MariaDB client. It does not modify the source database connection. Always test a restore on an isolated server before relying on disaster recovery.

### Backup layouts

Schedules support three layouts:

- **Single SQL file** keeps the original `.sql`, `.sql.gz`, or optional `.zip` artifact behavior.
- **One SQL file per database** creates a ZIP containing `DatabaseName/DatabaseName.sql` for every selected or visible database.
- **One SQL file per table** creates a ZIP containing `DatabaseName/TableName.sql` for every base table in every selected or visible database. In the schedule form, you can also include views, stored procedures/functions, triggers, and scheduled events. Selected non-table objects are written to `DatabaseName/_database-objects.sql` after the table files so restore can create dependent objects after their tables exist. Indexes are included automatically in each table definition.

The split layouts always use ZIP compression. Single-file and per-database layouts include the standard database objects automatically. ZIP backups can be downloaded, verified, and restored through the normal Backup history workflow. Existing schedules keep their previous object-selection behavior until edited.

### Backup folder layout

Every newly completed backup is placed below a schedule-specific folder on every storage type:

```text
<configured target>/<schedule-id folder>/<backup filename>
```

For local storage this is a real subdirectory. FTP/FTPS and WebDAV/Synology receive the same remote subdirectory, while Google Drive and OneDrive receive a schedule folder below the configured parent folder. The folder uses the immutable schedule ID rather than the editable display name, preventing collisions when names are duplicated or changed. Rotation is scoped to that folder. Older run records without a folder marker continue to use their original target-root location.

## Windows deployment with Laragon

These steps assume the project is located at `C:\vaultback`.

### 1. Verify the client tools

In PowerShell:

~~~powershell
Get-Command mysql
Get-Command mysqldump
~~~

If they are not found, use **Settings → Database tools** to install the supported portable pack, or copy a licensed matching client pack into the application-managed `tools/` layout. Binary-path variables from older configurations are ignored.

### 2. Install application dependencies

~~~powershell
Set-Location C:\vaultback
npm ci
~~~

Use `npm install` instead when there is no lockfile or when adding dependencies during development.

### 3. Create production configuration

~~~powershell
Copy-Item .env.example .env
notepad .env
~~~

Set a stable `APP_ENCRYPTION_KEY` and the desired `HOST`. Database client paths are intentionally ignored; VaultBack uses its application-managed tools directory for dump and restore operations.

### 4. Build and start

~~~powershell
npm run build
$env:NODE_ENV='production'
npm start
~~~

Open [the local VaultBack URL](http://127.0.0.1:3010).

The process must remain running for schedules to execute. For a permanent Windows deployment, run the process through a service manager such as NSSM or Windows Task Scheduler. Configure the working directory as the project directory and run `node dist/main.js` with the same environment variables as `.env`.

### 5. Verify dependencies

Open:

~~~text
http://127.0.0.1:3010/api/health
~~~

The response includes the detected client and dump-tool status. In **Settings → Database tools**, each MySQL/MariaDB pair is checked with `--no-defaults --version` and shown as **Working fine**, **Missing**, or **Corrupt or not responding**. Administrators can refresh the check. On supported hosts, **Repair and redownload tools** removes only VaultBack’s platform-specific portable directory and downloads a fresh checksum-verified package; system installations and paths configured in `.env` are never removed.

## Linux deployment with systemd

Install Node.js 22+, the client package, and the application under `/opt/vaultback`:

~~~bash
sudo mkdir -p /opt/vaultback
sudo chown "$USER" /opt/vaultback
cd /opt/vaultback
npm ci
npm run build
npm prune --omit=dev
cp .env.example .env
chmod 600 .env
~~~

Create `/etc/systemd/system/vaultback.service`:

~~~ini
[Unit]
Description=VaultBack database backup control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/vaultback
EnvironmentFile=/opt/vaultback/.env
ExecStart=/usr/bin/node /opt/vaultback/dist/main.js
Restart=on-failure
RestartSec=5
User=vaultback
Group=vaultback
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/vaultback/data

[Install]
WantedBy=multi-user.target
~~~

Create the service account, grant it access to the application and data directories, then start the service:

~~~bash
sudo useradd --system --home /opt/vaultback --shell /usr/sbin/nologin vaultback
sudo chown -R vaultback:vaultback /opt/vaultback
sudo systemctl daemon-reload
sudo systemctl enable --now vaultback
sudo systemctl status vaultback
~~~

Put a reverse proxy with HTTPS in front of VaultBack rather than exposing the Node port directly to the internet.

## Docker deployment

Build after compiling the application:

~~~bash
npm ci
npm run build
docker build -t vaultback:latest .
~~~

Create a persistent volume and run the container:

~~~bash
docker volume create vaultback-data
docker run -d \
  --name vaultback \
  --restart unless-stopped \
  -p 127.0.0.1:3010:3010 \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=3010 \
  -e DATA_DIR=/app/data \
  -e APP_ENCRYPTION_KEY="replace-with-a-stable-secret" \
  -v vaultback-data:/app/data \
  vaultback:latest
~~~

The image does not depend on a host database client. Use the guided installer after first login, or place licensed binaries under `/app/tools/` before building the image.

Check the container:

~~~bash
docker logs -f vaultback
docker inspect -f '{{.State.Status}}' vaultback
~~~

Do not publish the container directly to the public internet. Use an HTTPS reverse proxy and restrict access to the admin UI.

## First-time setup

1. Open the application URL.
2. Create the first administrator with a password of at least 12 characters.
3. If the dependency banner reports missing tools, choose **Set up database tools**. On supported Windows x64 and Linux x64 hosts, the guided installer downloads the official MariaDB Community client archive, verifies its published SHA-256 checksum, extracts the client and dump tools into the ignored `tools/` directory, and rechecks readiness. These tools are used for dumps and restores; connection tests and database discovery use the native Node driver. No database server is installed and no saved credential is included in the download request. Unsupported hosts should follow [the portable database-tools guide](tools/README.md) and place licensed binaries inside the application `tools/` directory; operating-system tools are not used.
4. Open **Settings → Database tools** to review the live status of both client pairs. If a portable tool becomes incomplete or stops responding, an administrator can confirm **Repair and redownload tools**. Repair affects only `tools/mariadb/<platform>-<arch>/`; it does not touch native binaries or `.env` paths.
5. Open **Databases** and add the MySQL/MariaDB connection credentials.
6. Use **Test connection**. A connection is not saved until the test succeeds.
7. Open **Storage targets** and add a local, FTP/FTPS, WebDAV/Synology, Google Drive, or OneDrive destination.
8. Open **Schedules** and choose the database connection and storage target.
9. Choose **All databases** or **Selected databases**. Selected mode loads a checklist from the live database connection.
10. Choose a backup layout and configure cron expression, timezone, compression, filename prefix, retention count, and database-object options. The per-table layout creates one SQL file per base table inside the ZIP and can add views, stored procedures/functions, triggers, and scheduled events in a separate database-objects file.
11. Save the schedule and use **Run now** for an initial backup test.
12. Confirm the artifact exists at the destination and inspect **Backup history**.

Use `127.0.0.1` for a local database server. Do not use `0.0.0.0` as a database destination; it is a server bind address, not a normal client address.

## Redeployment and migration

The following files are the persistent application state:

~~~text
data/vaultback.sqlite       # encrypted configuration, users, schedules, history
data/.encryption-key        # generated encryption key when APP_ENCRYPTION_KEY is not set
data/backups/               # local backup artifacts, if local storage is used
.env                        # deployment settings and optional stable key
~~~

Before redeploying:

1. Stop the old application process.
2. Back up the complete `data/` directory and `.env`.
3. Deploy the new application code and run `npm ci` or rebuild the image.
4. Restore the existing `data/` directory to the same `DATA_DIR`.
5. Restore the same `APP_ENCRYPTION_KEY`, if one was configured.
6. Start the new version and sign in with the existing administrator.
7. Verify connections, storage targets, schedules, and recent history.
8. Run one test backup before removing the old deployment.

Never copy `vaultback.sqlite` without also preserving `.encryption-key` when the key is generated automatically. Without the same key, encrypted database and storage credentials cannot be decrypted.

The public `/api/health` endpoint is intentionally limited to a liveness response. After sign-in, the GUI requests `/api/health/details` to check representative encrypted configuration records and dependency status. If `APP_ENCRYPTION_KEY` or `data/.encryption-key` is missing or wrong, the authenticated diagnostics response reports `encryption.status: "error"` and the GUI displays a recovery alert. Restore the original key and restart the application; do not delete or recreate the SQLite database.

The SQLite file is migrated automatically when new schema columns are introduced. Keep a recoverable copy before upgrades.

## Storage deployment notes

Live operational data uses the authenticated server-sent event stream at `/api/events`, not a repeating browser API poll. The stream is excluded from the normal API bucket after session authentication, is limited to five connections per user and twenty per source IP, sends heartbeats, and automatically closes when the session is revoked. Operators and viewers receive only process, backup-run, and storage-health topics; administrator-only sessions, per-IP rate-limit usage, and update topics are filtered at the server. If aaPanel/Nginx is used, disable proxy buffering for the VaultBack location so events are delivered immediately.

- **Local disk**: use the default `./data/backups` or a path allowed by the application. Local backup files are Git-ignored.
- **Live process monitor**: use the process indicator in the top bar on any registered page. Hover it for a compact summary, or click it to open the full live-process modal with stages, duration, and recent sanitized logs. The monitor receives server-sent updates over one authenticated stream and keeps completed or failed process summaries in memory for 15 minutes.
- **FTP/FTPS**: use a dedicated account and FTPS where supported.
- **WebDAV/Synology**: use the Synology WebDAV endpoint (commonly HTTPS port `5006`) and a dedicated account restricted to the backup directory. Prefer the NAS certificate hostname instead of an IP address. VaultBack verifies HTTPS certificates by default; only enable **Allow self-signed certificate** for that target when the NAS is on a trusted private network and its CA cannot be installed on the VaultBack host.
- **Google Drive/OneDrive**: use a narrowly scoped access token and protect `.env` and the SQLite encryption key.

The destination test button checks the configured storage adapter before relying on scheduled uploads.

## Web routes and 404 behavior

VaultBack serves the GUI and API from the same Node.js process. The registered browser routes are:

~~~text
/                 Overview
/overview         Overview (alias)
/databases        Databases
/connections      Databases (alias)
/storage          Storage targets
/schedules        Schedules
/jobs             Schedules (alias)
/history          Backup history
/runs             Backup history (alias)
/guide            Setup guide
/help             Setup guide (alias)
/settings         Settings
/sessions         Sessions & security (administrator only)
~~~

Unknown browser paths, including the old standalone `/processes` path, return HTTP 404 and display the in-app Page not found screen. Use the top-bar process indicator to access live process information. Unknown `/api/*` endpoints also return HTTP 404 rather than the GUI shell.

## Troubleshooting

### Client command not found

Use **Settings → Database tools** to download or repair the bundled client pack. Sign in and check the authenticated diagnostics response at `/api/health/details` for the detected status. VaultBack does not use client binaries from `PATH` or operating-system installation folders.

### Windows `spawn EPERM`

The Node process is not allowed to launch child processes. Run VaultBack under a normal service account with permission to execute the bundled client binaries, then use **Repair and redownload tools** if the application-managed files are incomplete.

### `unknown variable 'sql_mode=...'`

Current VaultBack commands use `--no-defaults` and should not read incompatible option-file entries. Rebuild and restart the application after upgrading.

### `caching_sha2_password could not be loaded`

The bundled client must load its authentication plugins from the application directory. Current releases pass the portable `lib/plugin` directory explicitly to the client and dump commands. Use the versioned release archive or **Settings → Software updates** for production updates, and use **Settings → Database tools → Repair and redownload tools** if the portable package is incomplete. Do not copy a system client over the managed tools.

### Connection test fails

- Confirm the database server is running.
- Use `127.0.0.1` rather than `0.0.0.0` for a local server.
- Verify host, port, username, password, and SSL selection.
- Confirm the account can connect from the VaultBack host.
- Confirm the account can run `SHOW DATABASES` if using the schedule checklist.
- Check the application log for the non-secret client error.

### A schedule cannot be saved

Every schedule requires a name, database connection, storage target, cron expression, and—when using selected mode—at least one selected database.

### Local backup permission errors

Ensure the VaultBack process user can write to `DATA_DIR` and the configured local backup directory. On Linux, check ownership of `/opt/vaultback/data`. On Windows, check the service account permissions.

### Port 3010 is already in use

Change `PORT` in `.env`, or stop the process currently listening on port 3010. If using a reverse proxy, keep VaultBack bound to localhost or a private interface.

## Security checklist

Before production use:

- Set a stable, high-entropy `APP_ENCRYPTION_KEY` outside source control.
- Keep `.env`, `data/vaultback.sqlite`, and `data/.encryption-key` private.
- Run the process under a dedicated low-privilege account.
- Put HTTPS and an access-control boundary in front of the admin UI.
- Restrict database accounts to the privileges required for backup and discovery.
- Use dedicated, limited storage accounts or tokens.
- Keep local backup paths within the intended data directory unless arbitrary paths are explicitly required.
- Back up the VaultBack control-plane data separately.
- Periodically perform a real restore test in an isolated environment.
- Monitor failed runs and storage capacity.

VaultBack is a secure foundation, not a replacement for a production security review. Add SSO/WebAuthn, external alerting, encrypted backup artifacts with a separate key, multi-instance job locking, and automated restore verification when required by the environment.

## Development commands

~~~powershell
npm ci
npm run start:dev   # watch mode
npm run typecheck   # typecheck without emitting dist
npm run build       # compile to dist/
npm start           # run the compiled application
npm run deploy:pm2  # install, build, and restart the existing PM2 process
~~~

`npm run deploy:pm2` is retained for source-code development deployments. For production aaPanel installations, use the versioned release archive, the hosted bootstrap installer, or **Settings → Software updates**; do not use `git pull` as the normal upgrade path.
