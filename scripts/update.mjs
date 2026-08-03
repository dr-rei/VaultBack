import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
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

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

const appRoot = path.resolve(argument('app-root', process.cwd()));
const envFile = { ...parseEnvFile(path.join(appRoot, '.env')), ...process.env };
const dataDir = path.resolve(argument('data-dir', path.join(appRoot, 'data')));
const targetVersion = argument('version').replace(/^v/, '');
const updateUrl = argument('url');
const expectedHash = argument('sha256').toLowerCase();
const healthUrl = argument('health-url');
const healthHost = argument('health-host', String(envFile.APP_DOMAIN || '127.0.0.1').split(',')[0].trim() || '127.0.0.1');
const pm2App = argument('pm2-app', String(envFile.UPDATE_PM2_APP || 'vaultback').trim() || 'vaultback');
const statusFile = path.join(dataDir, 'update-status.json');
const workRoot = path.join(dataDir, 'tmp', 'release-update');
const logFile = path.join(dataDir, 'logs', 'update.log');
let logFd;

function ensureLogFd() {
  if (logFd !== undefined) return logFd;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  logFd = fs.openSync(logFile, 'a');
  return logFd;
}

function log(message) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${String(message).replace(/\r?\n/g, '\n')}\n`);
}

function writeStatus(state, extra = {}) {
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  let current = {};
  try { if (fs.existsSync(statusFile)) current = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch {}
  const next = { ...current, state, targetVersion, updatedAt: new Date().toISOString(), ...extra };
  const temporary = `${statusFile}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statusFile);
  log(`state=${state}${extra.progress === undefined ? '' : ` progress=${extra.progress}`}${extra.error ? ` error=${extra.error}` : ''}`);
}

function fail(message) {
  writeStatus('failed', { error: String(message).slice(0, 500) });
  throw new Error(message);
}

function run(command, parameters, options = {}) {
  const executable = process.platform === 'win32' && command === 'pm2' ? 'pm2.cmd' : command;
  const childOptions = { encoding: 'utf8', windowsHide: true, ...options };
  if (!Object.prototype.hasOwnProperty.call(options, 'stdio')) childOptions.stdio = ['ignore', ensureLogFd(), ensureLogFd()];
  log(`command start: ${command}`);
  const result = spawnSync(executable, parameters, childOptions);
  if (result.stdout) log(String(result.stdout).trimEnd());
  if (result.stderr) log(String(result.stderr).trimEnd());
  if (result.error) { log(`command error: ${result.error.message}`); throw result.error; }
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || `${command} failed`).trim().slice(0, 500);
    log(`command failed (${result.status}): ${message}`);
    throw new Error(message);
  }
  log(`command completed: ${command}`);
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

function probeHealth() {
  return new Promise(resolve => {
    if (!healthUrl) return resolve(false);
    const target = new URL(healthUrl);
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(target, {
      method: 'GET',
      headers: { host: healthHost },
      rejectUnauthorized: false,
      timeout: 1500
    }, response => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function waitForHealth(expectedUp) {
  if (!healthUrl) return true;
  const deadline = Date.now() + (expectedUp ? 45000 : 30000);
  while (Date.now() < deadline) {
    if (await probeHealth() === expectedUp) return true;
    await new Promise(resolve => setTimeout(resolve, expectedUp ? 1000 : 400));
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
  log(`update started: ${targetVersion || 'unknown'} from ${process.cwd()}`);
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
  fs.mkdirSync(rollback, { recursive: true });
  copyManaged(appRoot, rollback);
  let stopped = false;
  try {
    writeStatus('stopping', { progress: 78 });
    if (pm2App) {
      run('pm2', ['describe', pm2App], { stdio: 'ignore' });
      run('pm2', ['stop', pm2App]);
      stopped = true;
      if (!await waitForHealth(false)) throw new Error('The application did not stop cleanly before the update.');
    }
    writeStatus('installing', { progress: 82 });
    copyManaged(releaseRoot, appRoot, true);
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: appRoot, stdio: 'ignore' });
    if (pm2App) {
      writeStatus('restarting', { progress: 95 });
      run('pm2', ['restart', pm2App, '--update-env']);
      if (!await waitForHealth(true)) throw new Error(`The updated application did not pass its health check at ${healthUrl}.`);
    }
  } catch (error) {
    writeStatus('rolling_back', { progress: 96, error: String(error?.message || error).slice(0, 500) });
    copyManaged(rollback, appRoot, true);
    try { run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: appRoot, stdio: 'ignore' }); } catch {}
    if (pm2App && stopped) {
      try { run('pm2', ['restart', pm2App, '--update-env']); } catch {}
    }
    throw new Error(`Update failed and the previous release was restored: ${String(error?.message || error).slice(0, 380)}`);
  }
  writeStatus('installed', { progress: 100, installedVersion: targetVersion, error: '', rollbackPath: rollback });
  log(`update completed: ${targetVersion}`);
}

try {
  await main();
} catch (error) {
  const message = String(error?.stack || error?.message || error).slice(0, 2000);
  try { log(`update failed: ${message}`); writeStatus('failed', { error: message.slice(0, 500) }); } catch {}
  process.exitCode = 1;
} finally {
  if (logFd !== undefined) {
    try { fs.closeSync(logFd); } catch {}
  }
}
