import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const args = process.argv.slice(2);

function argument(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? String(args[index + 1] || fallback) : fallback;
}

const version = argument('version', packageJson.version).replace(/^v/, '');
const platform = argument('platform', process.platform);
const architecture = argument('arch', process.arch);
const outputRoot = path.resolve(projectRoot, argument('output', 'release'));
const releaseName = `VaultBack-${version}-${platform}-${architecture}`;
const stagingRoot = path.join(outputRoot, releaseName);
const archivePath = path.join(outputRoot, `${releaseName}.tar.gz`);

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid release version: ${version}`);
fs.mkdirSync(outputRoot, { recursive: true });
fs.rmSync(stagingRoot, { recursive: true, force: true });
fs.rmSync(archivePath, { force: true });

const files = ['package.json', 'package-lock.json', 'ecosystem.config.cjs', 'README.md', 'LICENSE', '.env.example'];
const directories = ['dist', 'public', 'scripts', 'docs'];
for (const file of files) {
  const source = path.join(projectRoot, file);
  if (fs.existsSync(source)) {
    fs.mkdirSync(path.dirname(path.join(stagingRoot, file)), { recursive: true });
    fs.cpSync(source, path.join(stagingRoot, file));
  }
}
for (const directory of directories) {
  const source = path.join(projectRoot, directory);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(stagingRoot, directory), { recursive: true });
}

if (!fs.existsSync(path.join(stagingRoot, 'dist', 'main.js'))) throw new Error('dist/main.js is missing; run npm run build first.');
if (!fs.existsSync(path.join(stagingRoot, 'public', 'index.html'))) throw new Error('public/index.html is missing.');

const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
const result = spawnSync(tar, ['-czf', archivePath, '-C', outputRoot, releaseName], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Could not create ${path.basename(archivePath)}.`);

const hash = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
const metadata = { version, platform, architecture, file: path.basename(archivePath), sha256: hash, bytes: fs.statSync(archivePath).size, createdAt: new Date().toISOString(), host: os.platform() };
fs.writeFileSync(path.join(outputRoot, `${releaseName}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
fs.rmSync(stagingRoot, { recursive: true, force: true });
console.log(JSON.stringify(metadata, null, 2));
