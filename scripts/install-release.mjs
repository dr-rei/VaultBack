import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const managedPaths = ['dist', 'public', 'package.json', 'package-lock.json', 'ecosystem.config.cjs', 'scripts', 'docs', 'README.md', 'LICENSE'];
const args = process.argv.slice(2);

function argument(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? String(args[index + 1] || fallback) : fallback;
}

function parseEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function run(command, parameters, options = {}) {
  const executable = process.platform === 'win32' && command === 'pm2' ? 'pm2.cmd' : command;
  const result = spawnSync(executable, parameters, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `${command} failed`).trim().slice(0, 500));
  return result;
}

function hasPm2Process(name) {
  if (!name) return false;
  const executable = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';
  const result = spawnSync(executable, ['describe', name], { encoding: 'utf8', windowsHide: true });
  return !result.error && result.status === 0;
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
  if (new URL(response.url).protocol !== 'https:') throw new Error('The release server redirected to an insecure URL.');
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_ARCHIVE_BYTES) throw new Error('The release package exceeds the safe download limit.');
  let bytes = 0;
  const stream = Readable.fromWeb(response.body);
  stream.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_ARCHIVE_BYTES) stream.destroy(new Error('The release package exceeds the safe download limit.')); });
  await pipeline(stream, createWriteStream(destination));
  if (!bytes) throw new Error('The release package was empty.');
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function safeEntries(archive) {
  const result = run('tar', ['-tzf', archive], { stdio: ['ignore', 'pipe', 'pipe'] });
  const entries = String(result.stdout || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..') || /^[A-Za-z]:/.test(normalized)) throw new Error('The release package contains an unsafe path.');
  }
  return entries;
}

function locateRelease(stage) {
  if (fs.existsSync(path.join(stage, 'package.json'))) return stage;
  const child = fs.readdirSync(stage, { withFileTypes: true }).find(item => item.isDirectory() && fs.existsSync(path.join(stage, item.name, 'package.json')));
  return child ? path.join(stage, child.name) : '';
}

function copyManaged(fromRoot, toRoot, replace = false) {
  for (const item of managedPaths) {
    const source = path.join(fromRoot, item); const destination = path.join(toRoot, item);
    if (replace) fs.rmSync(destination, { recursive: true, force: true });
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.cpSync(source, destination, { recursive: true });
  }
}

async function waitForHealth(url, expectedUp) {
  const deadline = Date.now() + (expectedUp ? 45000 : 30000);
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (response.ok === expectedUp) return true; } catch { if (!expectedUp) return true; }
    await new Promise(resolve => setTimeout(resolve, expectedUp ? 1000 : 400));
  }
  return !expectedUp;
}

async function main() {
  const appRoot = path.resolve(argument('app-root', process.cwd()));
  const envFile = { ...parseEnvFile(path.join(appRoot, '.env')), ...process.env };
  const manifestUrl = argument('manifest-url', 'https://github.com/dr-rei/VaultBack/releases/latest/download/latest.json');
  const pm2App = argument('pm2-app', envFile.UPDATE_PM2_APP || 'vaultback');
  if (!/^https:\/\//i.test(manifestUrl)) throw new Error('The release manifest URL must use HTTPS.');
  const manifestResponse = await fetch(manifestUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json', 'user-agent': 'VaultBack release installer' } });
  if (manifestResponse.status === 404) throw new Error('No published release manifest was found. Publish a successful release containing latest.json first.');
  if (!manifestResponse.ok) throw new Error(`Manifest download failed with HTTP ${manifestResponse.status}.`);
  if (new URL(manifestResponse.url).protocol !== 'https:') throw new Error('The manifest server redirected to an insecure URL.');
  const manifest = await manifestResponse.json();
  const targetVersion = String(manifest.version || '').replace(/^v/, '');
  const currentPackage = path.join(appRoot, 'package.json');
  const currentVersion = fs.existsSync(currentPackage)
    ? String(JSON.parse(fs.readFileSync(currentPackage, 'utf8')).version || '0.0.0')
    : '0.0.0';
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(targetVersion)) throw new Error('The release manifest has an invalid version.');
  const compare = (left, right) => left.split('-')[0].split('.').map(Number).reduce((total, part, index) => total || part - (Number(right.split('-')[0].split('.')[index]) || 0), 0);
  if (compare(targetVersion, currentVersion) <= 0) { console.log(`VaultBack is already at ${currentVersion}.`); return; }
  const key = `${process.platform}-${process.arch}`; const artifact = manifest.artifacts?.[key];
  if (!artifact || !/^https:\/\//i.test(String(artifact.url || '')) || !/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ''))) throw new Error(`No valid release artifact is available for ${key}.`);
  const workRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vaultback-release-')); const archive = path.join(workRoot, 'release.tar.gz'); const stage = path.join(workRoot, 'stage');
  try {
    console.log(`Downloading VaultBack ${targetVersion} for ${key}...`); await download(String(artifact.url), archive);
    if (sha256(archive) !== String(artifact.sha256).toLowerCase()) throw new Error('Release checksum verification failed.');
    safeEntries(archive); fs.mkdirSync(stage, { recursive: true }); run('tar', ['-xzf', archive, '-C', stage], { stdio: 'ignore' });
    const releaseRoot = locateRelease(stage); if (!releaseRoot || !fs.existsSync(path.join(releaseRoot, 'dist', 'main.js'))) throw new Error('Release package is missing dist/main.js.');
    const packageVersion = String(JSON.parse(fs.readFileSync(path.join(releaseRoot, 'package.json'), 'utf8')).version || ''); if (packageVersion !== targetVersion) throw new Error('Release package version does not match its manifest.');
    const protocol = String(envFile.APP_PROTOCOL || 'http').toLowerCase(); const secure = protocol === 'https' || protocol === 'both'; const port = protocol === 'both' ? Number(envFile.HTTPS_PORT || 3443) : Number(envFile.PORT || 3010); const healthUrl = `${secure ? 'https' : 'http'}://127.0.0.1:${port}/api/health`;
    const rollback = path.join(appRoot, 'data', 'tmp', 'release-install', `${targetVersion}-${Date.now()}`, 'rollback'); fs.mkdirSync(rollback, { recursive: true }); copyManaged(appRoot, rollback);
    const existingPm2Process = hasPm2Process(pm2App);
    if (existingPm2Process) { console.log(`Stopping PM2 process ${pm2App}...`); run('pm2', ['stop', pm2App]); await waitForHealth(healthUrl, false); }
    try {
      copyManaged(releaseRoot, appRoot, true); run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: appRoot, stdio: 'inherit' });
      if (pm2App) {
        if (existingPm2Process) run('pm2', ['restart', pm2App, '--update-env']);
        else { run('pm2', ['start', path.join(appRoot, 'ecosystem.config.cjs'), '--only', pm2App]); run('pm2', ['save']); }
        if (!await waitForHealth(healthUrl, true)) throw new Error('The updated application did not pass its health check.');
      }
      console.log(`VaultBack ${targetVersion} installed successfully.`);
    } catch (error) {
      console.error(`Update failed; restoring ${currentVersion}...`); copyManaged(rollback, appRoot, true); try { run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: appRoot, stdio: 'inherit' }); } catch {}
      if (existingPm2Process) { try { run('pm2', ['restart', pm2App, '--update-env']); } catch {} }
      throw new Error(`Update failed and the previous release was restored: ${String(error?.message || error).slice(0, 380)}`);
    }
  } finally { fs.rmSync(workRoot, { recursive: true, force: true }); }
}

try { await main(); } catch (error) { console.error(String(error?.message || error)); process.exitCode = 1; }
