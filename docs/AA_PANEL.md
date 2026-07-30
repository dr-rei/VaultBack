# aaPanel deployment guide

This guide deploys VaultBack as an aaPanel Node.js/PM2 project. It assumes a Linux aaPanel server and a domain that will proxy to VaultBack on a private local port.

The current release line is published on [GitHub Releases](https://github.com/dr-rei/VaultBack/releases). For a new aaPanel installation, use the `VaultBack-<version>-linux-x64.tar.gz` archive. Git is only needed for developing VaultBack itself.

The field names in this guide follow aaPanel’s current Node.js Project documentation: [aaPanel Node.js Project documentation](https://www.aapanel.com/docs/Function/Node.html).

## What aaPanel needs

- Node.js 22 or newer. Node.js 24 is also supported.
- One PM2 process with one instance. The scheduler runs inside this process.
- A writable project directory, for example `/www/wwwroot/vaultback`.
- Bundled MySQL or MariaDB dump tools under the application directory. The database server may be remote; VaultBack uses the native Node driver for connection tests and database discovery, and the bundled clients for dumps and restores.
- A domain and SSL certificate configured through aaPanel’s Website panel.

VaultBack uses SQLite for its own control-plane data. You do not need to create a separate MySQL database for VaultBack.

## Recommended deployment: PM2 Project

### 1. Install Node.js

In aaPanel, open **App Store → Node.js version manager** and install Node.js 22 or newer. The Node version selected for the project must be the same version used to build and run the application.

### 2. Upload the versioned release archive

For the recommended production installation:

1. Open the [VaultBack releases page](https://github.com/dr-rei/VaultBack/releases) and download the latest `VaultBack-<version>-linux-x64.tar.gz` asset.
2. In aaPanel File Manager, upload it to a temporary directory such as `/www/server/temp/`.
3. Extract it and copy the extracted application directory contents into `/www/wwwroot/vaultback/`.
4. Confirm that `dist/main.js`, `public/index.html`, `package.json`, `scripts/`, and `ecosystem.config.cjs` exist.

The release archive already contains the compiled `dist/` directory. It intentionally does not contain `data/`, `.env`, local backups, or portable database binaries.

### Git installation alternative

You can upload a release ZIP, or use aaPanel’s **Pull Git project** button from the PM2 Project form shown in your screenshot.

For this repository, use:

| Git pull field | Value |
|---|---|
| Repository | `git@github.com:dr-rei/VaultBack.git` |
| Branch | `main` |
| Pull directory | `/www/wwwroot/vaultback` |

If the repository is private, click **Generate new key** (or use an existing aaPanel key), copy the displayed public SSH key, and add it to GitHub as a repository deploy key with read access. Never upload or paste the private key into GitHub. For a public repository, an HTTPS clone URL can also be used if aaPanel supports it.

The project directory must contain:

~~~text
/www/wwwroot/vaultback
~~~

After a Git pull, confirm it contains `package.json`, `src/`, `public/`, `tools/`, and `ecosystem.config.cjs`. A release archive contains `dist/` instead of `src/` and is ready for the PM2 project after production dependencies are installed.

### 3. Prepare the project

Open **aaPanel → Terminal**, then run the following as the project owner. Replace the path if you used a different directory:

~~~bash
cd /www/wwwroot/vaultback
chmod +x scripts/aapanel-prepare.sh
bash scripts/aapanel-prepare.sh
~~~

The script will:

1. Verify Node.js 22 or newer.
2. Install dependencies with `npm ci`.
3. Compile the backend to `dist/`.
4. Create `data/backups/` with restricted permissions.
5. Create `.env` from `.env.example` if needed.
6. Generate a stable encryption key if `.env` does not have one.

For a self-contained aaPanel deployment, copy the matching standalone client pack into the project before starting PM2:

~~~text
/www/wwwroot/vaultback/tools/mysql/linux-x64/bin/mysql
/www/wwwroot/vaultback/tools/mysql/linux-x64/bin/mysqldump
/www/wwwroot/vaultback/tools/mariadb/linux-x64/bin/mariadb
/www/wwwroot/vaultback/tools/mariadb/linux-x64/bin/mariadb-dump
~~~

Make the binaries executable:

~~~bash
chmod +x tools/mysql/linux-x64/bin/* tools/mariadb/linux-x64/bin/*
~~~

VaultBack selects the MySQL pack for MySQL connections and the MariaDB pack for MariaDB connections. It searches only these application folders; system-wide client installations and `PATH` entries are ignored. Obtain the binaries from the official vendor distribution and follow their licenses; they are intentionally not included in the application repository. On supported hosts, an administrator can download the verified pack from **Settings → Database tools**.

### 4. Configure `.env`

Edit the file:

~~~bash
nano /www/wwwroot/vaultback/.env
~~~

Use these production values:

~~~env
NODE_ENV=production
HOST=127.0.0.1
PORT=3010
APP_DOMAIN=backup.example.com
APP_PROTOCOL=http
DATA_DIR=/www/wwwroot/vaultback/data
APP_ENCRYPTION_KEY=the-value-generated-by-the-prepare-script
ALLOW_ANY_LOCAL_PATH=false
RATE_LIMIT_PER_MINUTE=800
MAX_LOGIN_SESSIONS_PER_USER=0
UPDATE_CHANNEL=stable
UPDATE_PM2_APP=vaultback
~~~

`RATE_LIMIT_PER_MINUTE` limits normal API requests per client IP in production. `MAX_LOGIN_SESSIONS_PER_USER=0` allows unlimited concurrent sessions for each account; set a positive value to remove the oldest sessions before a new login is created. Restart PM2 after changing `.env`.

If the client commands are not detected automatically, open **Settings → Database tools** and use **Repair and redownload tools**. For unsupported platforms, copy licensed binaries into the application’s matching `tools/<engine>/<platform>-<arch>/bin/` directory.

Do not replace `APP_ENCRYPTION_KEY` after the application has saved credentials. The same key and the same `data/` directory are required to read existing encrypted settings after a redeployment.

### 5. Create the aaPanel Node.js project

Use the **PM2 Project** tab shown in aaPanel:

| aaPanel field | Value |
|---|---|
| Project Name | `vaultback` |
| Node Version | Node.js 22 or newer |
| Startup File | `dist/main.js` |
| Run Directory | `/www/wwwroot/vaultback` |
| Cluster | `1` |
| Memory Limit | `512 MB` or `1024 MB` |
| Auto Restart | On |
| Package Manager | `npm` |

If aaPanel asks to install dependencies automatically, leave **Do not install node_module** unchecked on the first deployment. The preparation script runs `npm ci` and `npm run build`; after those commands complete, the project is ready to start with `dist/main.js`.

If you already ran the preparation script successfully, selecting **Do not install node_module** is acceptable because `node_modules/` and `dist/` are already present. For a release archive, install production dependencies with `npm ci --omit=dev --ignore-scripts`; the archive already includes `dist/main.js`, so a source build is not required.

Alternatively, start the included PM2 configuration from the terminal:

~~~bash
cd /www/wwwroot/vaultback
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
~~~

Keep **Auto Restart** enabled. The GUI **Restart application** action gracefully stops the Node process and depends on PM2/aaPanel to start it again. A process started directly with `npm start` will shut down and will not self-relaunch.

Run the command printed by `pm2 startup` once with the elevated permissions requested by aaPanel. This makes the process return after a server reboot.

### 6. Test the private application port

From the server, check that the process is running:

~~~bash
pm2 status
pm2 logs vaultback --lines 50
curl -I http://127.0.0.1:3010/
~~~

The application should remain bound to `127.0.0.1` when a domain reverse proxy is used.

### 7. Bind a domain and enable HTTPS

In aaPanel:

1. Open **Website → Add site** and create the domain.
2. Open the site’s **Reverse Proxy** settings.
3. Add a proxy to `http://127.0.0.1:3010`.
4. Enable **WebSocket** support if aaPanel offers that option.
5. Issue an SSL certificate and enable **Force HTTPS**.
6. Open the HTTPS domain in a browser and create the first VaultBack administrator.

Do not expose port 3010 directly to the public internet when a reverse proxy is available. Allow only ports 80 and 443 in the firewall.

## Default Project alternative

The **Default Project** tab can also run the application:

| aaPanel field | Value |
|---|---|
| Path | `/www/wwwroot/vaultback` |
| Name | `vaultback` |
| Run option | `npm start` or the package.json start command |
| Port | `3010` |
| User | `www` or the same owner used for the project files |
| Node | Node.js 22 or newer |

Before using this mode, run the preparation script so `dist/main.js` already exists. PM2 Project mode is preferred because aaPanel exposes restart, logs, memory limits, and boot persistence more clearly.

## MySQL/MariaDB client installation

VaultBack does not need a second database server. It needs the command-line client on the aaPanel host.

On Debian/Ubuntu-style servers, an administrator can install the MariaDB client with:

~~~bash
sudo apt-get update
sudo apt-get install -y mariadb-client ca-certificates
~~~

Then verify:

~~~bash
mariadb --version
mariadb-dump --version
~~~

If aaPanel uses another Linux distribution, install the equivalent MariaDB/MySQL **client** package through that distribution’s package manager. Do not install a second database server unless you actually need one.

## First login and first backup

1. Open the HTTPS domain.
2. Create the administrator with a long, unique password.
3. Open **Databases → Add database**.
4. Enter the database host, port, username, and password. Password may be blank if the database allows it.
5. Click **Test connection**, then save.
6. Open **Storage targets** and follow the provider guide inside the form.
7. Test the storage target after saving.
8. Create a schedule and choose all databases or selected databases.
9. Click **Run now** and confirm the backup file exists at the destination.

## File permissions and backups

The PM2 process user must be able to read the project and write to:

~~~text
/www/wwwroot/vaultback/data
/www/wwwroot/vaultback/data/backups
~~~

Back up these items before upgrades or server migration:

~~~text
/www/wwwroot/vaultback/data/vaultback.sqlite
/www/wwwroot/vaultback/data/.encryption-key     # if APP_ENCRYPTION_KEY is not used
/www/wwwroot/vaultback/.env
~~~

Never expose `.env`, `data/vaultback.sqlite`, `.encryption-key`, or local backup files through the website’s public document root. Keep `APP_ENCRYPTION_KEY` unchanged during redeployment.

## Updating the application without Git

The recommended production flow uses the versioned release feed and the administrator-only **Settings → Software updates** panel. It does not require GitHub SSH keys or `git pull` after the initial installation.

Before enabling it, add the PM2 process name to `.env`:

~~~env
UPDATE_PM2_APP=vaultback
UPDATE_CHANNEL=stable
# Optional only when using a private/self-hosted release server:
# UPDATE_MANIFEST_URL=https://updates.example.com/vaultback/latest.json
~~~

Then:

1. Keep the aaPanel project in PM2 mode with **Auto Restart** enabled and one instance.
2. Keep a recovery copy of `data/`, `.env`, and the stable `APP_ENCRYPTION_KEY`.
3. Sign in as an administrator and open **Settings → Software updates**.
4. Select **Check for updates**, review the release notes, and select **Install update**.
5. Wait for PM2 to restart the process. Do not run a backup during the update.

The updater downloads the HTTPS archive, verifies SHA-256, preserves `data/`, `.env`, and `tools/`, installs production dependencies, restarts `vaultback`, and checks `/api/health`. If a step fails, it restores the previous application files and restarts PM2. See [the complete release topology and manifest guide](RELEASES.md).

For a manual maintenance update, first make a recovery copy and stop PM2:

~~~bash
cd /www/wwwroot/vaultback
stamp=$(date +%Y%m%d-%H%M%S)
cp -a data "data-before-update-$stamp"
cp -a .env ".env-before-update-$stamp"
cp -a tools "tools-before-update-$stamp"
pm2 stop vaultback
~~~

Extract the downloaded archive into a temporary directory, then copy only the application files:

~~~bash
mkdir -p /tmp/vaultback-update
tar -xzf /tmp/VaultBack-<version>-linux-x64.tar.gz -C /tmp/vaultback-update
release=/tmp/vaultback-update/VaultBack-<version>-linux-x64
cd /www/wwwroot/vaultback
cp -a "$release/dist" "$release/public" "$release/scripts" "$release/docs" .
cp "$release/package.json" "$release/package-lock.json" "$release/ecosystem.config.cjs" "$release/README.md" "$release/LICENSE" .
npm ci --omit=dev --ignore-scripts
pm2 restart vaultback --update-env
pm2 save
curl -f http://127.0.0.1:3010/api/health
~~~

Never copy `data/`, `.env`, or `tools/` from the archive and never run `git pull` as part of this release update.

## Common problems

- **502 Bad Gateway**: check `pm2 status`, `pm2 logs vaultback`, and that port 3010 is listening.
- **Client command not found**: open **Settings → Database tools** and use **Set up database tools** or **Repair and redownload tools**. For unsupported platforms, place licensed binaries in the application’s `tools/` directory.
- **Permission denied**: make the project owner the same user that runs PM2, and ensure it can write to `data/`.
- **Credentials cannot be decrypted after redeploy**: restore the original `data/` directory and the same `APP_ENCRYPTION_KEY`.
- **GUI restart leaves the site offline**: confirm the aaPanel project is running under PM2 with **Auto Restart** enabled; the restart action intentionally sends a graceful shutdown signal and does not self-launch a replacement process.
- **Cloud storage token rejected**: generate a new provider token and update the storage target. The current manual-token cloud adapters do not refresh expired tokens automatically.
