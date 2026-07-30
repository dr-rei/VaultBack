# VaultBack release and in-app update operations

VaultBack is distributed as versioned release archives. A deployment does not need Git access after the initial installation, and normal updates do not use `git pull`.

## Release topology

```text
Developer workstation
        │ push tag v1.2.3
        ▼
GitHub Actions
  build + package + SHA-256
        ▼
GitHub Release
  VaultBack-1.2.3-linux-x64.tar.gz
  latest.json
        ▲
        │ HTTPS manifest check/download
        │
VaultBack administrator → Settings → Software updates
        │
        └─ updater preserves data/.env/tools, replaces application files, restarts PM2
```

The included workflow publishes Linux x64 for aaPanel and Windows x64 packages from the same application source. Add another artifact to the manifest when publishing an ARM build; the artifact key must match `${process.platform}-${process.arch}`, for example `linux-arm64`.

## One-command bootstrap installers

The repository hosts small Linux and Windows bootstrap scripts so an administrator does not need to upload an archive, extract it, run `npm ci`, and restart PM2 as separate steps. Both launchers download the latest HTTPS manifest and pass control to the Node installer included in the release process:

Linux/aaPanel:

```bash
curl --fail --location --proto '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/dr-rei/VaultBack/main/scripts/install-release.sh \
  | sudo -u www -H env "PATH=$PATH" bash -s -- /www/wwwroot/vaultback
```

Windows PowerShell:

```powershell
$installer = Join-Path $env:TEMP 'vaultback-install.ps1'
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/dr-rei/VaultBack/main/scripts/install-release.ps1 -OutFile $installer
powershell -ExecutionPolicy Bypass -File $installer -AppRoot 'C:\VaultBack' -Pm2App vaultback
Remove-Item -LiteralPath $installer -Force
```

The default PM2 process name is `vaultback`; use `--pm2-app` on Linux or `-Pm2App` on Windows when it differs. On aaPanel, run the Linux command as `www` so the application and PM2 files have the correct owner. The installer supports an empty application directory for first installation and an existing deployment for upgrades. It downloads the platform artifact, verifies its SHA-256 value from `latest.json`, preserves `data/`, `.env`, and `tools/`, installs production dependencies, starts or restarts PM2, and checks `/api/health` on loopback while sending the configured `APP_DOMAIN` as the `Host` header. If needed, override that header with Linux `--health-host` or Windows `-HealthHost`. Existing application files are restored automatically if the deployment fails.

Required host tools are Node.js 22 or newer, PM2, and the platform's normal `curl`/PowerShell and `tar` utilities. The command still requires first-time configuration of `.env`, the stable encryption key, and database client tools. Review the launcher before piping it into a shell; environments that require pinned inputs can replace the `main` URL with a reviewed Git tag.

## Publish a release

1. Update `version` in `package.json` and commit the change.
2. Create and push an annotated tag with the exact same version:

   ```bash
   git tag -a v1.2.3 -m "VaultBack 1.2.3"
   git push origin main --follow-tags
   ```

3. GitHub Actions runs `.github/workflows/release.yml`, builds `dist/`, creates the archive, calculates its SHA-256 checksum, creates `latest.json`, and publishes a GitHub Release.
4. Confirm the release asset and `latest.json` are publicly readable before enabling automatic checks for users.

Do not put `data/`, `.env`, credentials, local backups, or `tools/` binaries into the release archive. The package script intentionally excludes them.

## Configure a deployment

For the default GitHub feed, no update URL is required. To use a private or self-hosted release server, set an HTTPS URL in `.env`:

```env
UPDATE_MANIFEST_URL=https://updates.example.com/vaultback/latest.json
UPDATE_CHANNEL=stable
UPDATE_PM2_APP=vaultback
```

The manifest must contain a semantic `version`, optional release notes, and an artifact for the current platform. Each artifact must include an HTTPS `url`, a lowercase or uppercase 64-character SHA-256 `sha256`, and optional `bytes`. Example:

```json
{
  "version": "1.2.3",
  "channel": "stable",
  "releaseNotesUrl": "https://github.com/dr-rei/VaultBack/releases/tag/v1.2.3",
  "artifacts": {
    "linux-x64": {
      "url": "https://updates.example.com/vaultback/VaultBack-1.2.3-linux-x64.tar.gz",
      "sha256": "replace-with-the-64-character-sha256",
      "bytes": 1234567
    }
  }
}
```

`UPDATE_PM2_APP` is important for unattended updates. The updater stops the named PM2 process, verifies the archive, makes a rollback copy of managed application files, installs dependencies, restarts PM2, and checks `/api/health`. If installation or health verification fails, it restores the previous release and restarts PM2. The updater never replaces `data/`, `tools/`, or `.env`.

## aaPanel user flow

1. Keep the project under PM2 with **Auto Restart** enabled and a single instance.
2. Set `UPDATE_PM2_APP=vaultback` in the deployment `.env` or PM2 environment.
3. Sign in as an administrator and open **Settings → Software updates**.
4. Select **Check for updates**, review the version and release notes, then select **Install update**.
5. Do not start a backup while the update is installing. The browser may disconnect briefly while PM2 restarts the process.
6. If the site does not return, inspect `pm2 status`, `pm2 logs vaultback`, and `data/update-status.json`.

Before every upgrade, retain a copy of `data/`, `.env`, and the current `APP_ENCRYPTION_KEY`. The release updater is designed to preserve them, but these are still the recovery boundary for encrypted credentials and application state.
