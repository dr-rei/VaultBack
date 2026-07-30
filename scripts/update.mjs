import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const managedPaths = ['dist', 'public', 'package.json', 'package-lock.json', 'ecosystem.config.cjs', 'scripts', 'docs', 'README.md', 'LICENSE', '.env.example'];
const args = process.argv.slice(2);

function argument(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? String(args[index + 1] || fallback) : fallback;
}

const appRoot = path.resolve(argument('app-root', process.cwd()));
const dataDir = path.resolve(argument('data-dir', path.join(appRoot, 'data')));
const targetVersion = argument('version').replace(/^v/, '');
const updateUrl = argument('url');
const expectedHash = argument('sha256').toLowerCase();
const healthUrl = argument('health-url');
const pm2App = argument('pm2-app');
const statusFile = path.join(dataDir, 'update-status.json');
const workRoot = path.join(dataDir, 'tmp', 'release-update');

function writeStatus(state, extra = {}) {
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  let current = {};
  try { if (fs.existsSync(statusFile)) current = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch {}
  const next = { ...current, state, targetVersion, updatedAt: new Date().toISOString(), ...extra };
  const temporary = `${statusFile}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statusFile);
}

function fail(message) {
  writeStatus('failed', { error: String(message).slice(0, 500) });
  throw new Error(message);
}

function run(command, parameters, options = {}) {
  const executable = process.platform === 'win32' && command === 'pm2' ? 'pm2.cmd' : command;
  const result = spawnSync(executable, parameters, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `${command} failed`).trim().slice(0, 500));
  return result;
}

async function download(url, destination) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Release downloads must use HTTPS.');
  const response = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (new URL(response.url).protocol !== 'https:') throw new Error('The release server redirected to an insecure URL.');
  if (!response.ok || !response.body) throw new Error(`Release download failed with HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_ARCHIVE_BYTES) throw new Error('The release package exceeds the safe download limit.');
  let bytes = 0;
  const stream = Readable.fromWeb(response.body);
  stream.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_ARCHIVE_BYTES) stream.destroy(new Error('The release package exceeds the safe download limit.')); });
  await pipeline(stream, createWriteStream(destination));
  if (!bytes) throw new Error('The release package was empty.');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function archiveEntries(archive) {
  const result = run('tar', ['-tzf', archive], { stdio: ['ignore', 'pipe', 'pipe'] });
  return String(result.stdout || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

function assertSafeArchive(entries) {
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..') || /^[A-Za-z]:/.test(normalized)) throw new Error('The release package contains an unsafe path.');
  }
}

function locateRelease(stage) {
  if (fs.existsSync(path.join(stage, 'package.json'))) return stage;
  const children = fs.readdirSync(stage, { withFileTypes: true }).filter(item => item.isDirectory());
  const candidate = children.find(item => fs.existsSync(path.join(stage, item.name, 'package.json')));
  return candidate ? path.join(stage, candidate.name) : '';
}

async function waitForHealthDown() {
  if (!healthUrl) return;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { await fetch(healthUrl, { signal: AbortSignal.timeout(800) }); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
}

async function waitForHealthUp() {
  if (!healthUrl) return true;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) }); if (response.ok) return true; } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

function copyManaged(fromRoot, toRoot, replace = false) {
  for (const item of managedPaths) {
    const source = path.join(fromRoot, item);
    const destination = path.join(toRoot, item);
    if (replace) fs.rmSync(destination, { recursive: true, force: true });
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
  }
}

async function main() {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(targetVersion)) throw new Error('Invalid target release version.');
  if (!/^[a-f0-9]{64}$/i.test(expectedHash)) throw new Error('The release SHA-256 value is invalid.');
  if (!updateUrl) throw new Error('The release URL is missing.');
  fs.mkdirSync(workRoot, { recursive: true });
  const runRoot = path.join(workRoot, `${targetVersion}-${Date.now()}`);
  const archive = path.join(runRoot, 'release.tar.gz');
  const stage = path.join(runRoot, 'stage');
  const rollback = path.join(runRoot, 'rollback');
  fs.mkdirSync(runRoot, { recursive: true });
  writeStatus('downloading', { error: '', progress: 0 });
  await download(updateUrl, archive);
  writeStatus('verifying', { progress: 60 });
  if (sha256(archive) !== expectedHash) return fail('Release checksum verification failed.');
  writeStatus('extracting', { progress: 70 });
  const entries = archiveEntries(archive); assertSafeArchive(entries);
  fs.mkdirSync(stage, { recursive: true });
  run('tar', ['-xzf', archive, '-C', stage], { stdio: 'ignore' });
  const releaseRoot = locateRelease(stage);
  if (!releaseRoot || !fs.existsSync(path.join(releaseRoot, 'dist', 'main.js')) || !fs.existsSync(path.join(releaseRoot, 'public', 'index.html'))) return fail('Release package is missing required application files.');
  const releasePackage = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'package.json'), 'utf8'));
  if (String(releasePackage.version || '').replace(/^v/, '') !== targetVersion) return fail('Release package version does not match the manifest.');
  writeStatus('stopping', { progress: 78 });
  if (pm2App) run('pm2', ['stop', pm2App]);
  await waitForHealthDown();
  fs.mkdirSync(rollback, { recursive: true });
  copyManaged(appRoot, rollback);
  try {
    writeStatus('installing', { progress: 82 });
    copyManaged(releaseRoot, appRoot, true);
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: appRoot, stdio: 'ignore' });
    if (pm2App) {
      writeStatus('restarting', { progress: 95 });
      run('pm2', ['restart', pm2App, '--update-env']);
      if (!await waitForHealthUp()) throw new Error('The updated application did not pass its health check.');
    }
  } catch (error) {
    writeStatus('rolling_back', { progress: 96, error: String(error?.message || error).slice(0, 500) });
    copyManaged(rollback, appRoot, true);
    try { run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: appRoot, stdio: 'ignore' }); } catch {}
    if (pm2App) {
      try { run('pm2', ['restart', pm2App, '--update-env']); } catch {}
    }
    throw new Error(`Update failed and the previous release was restored: ${String(error?.message || error).slice(0, 380)}`);
  }
  writeStatus('installed', { progress: 100, installedVersion: targetVersion, error: '', rollbackPath: rollback });
}

try {
  await main();
} catch (error) {
  try { writeStatus('failed', { error: String(error?.message || error).slice(0, 500) }); } catch {}
  process.exitCode = 1;
}
