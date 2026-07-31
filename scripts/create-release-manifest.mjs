import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);

function value(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? String(args[index + 1] || fallback) : fallback;
}

function artifactArguments() {
  return args.flatMap((item, index) => item === '--artifact' ? [args[index + 1]] : []).filter(Boolean);
}

const version = value('version').replace(/^v/, '');
const repository = value('repository', process.env.GITHUB_REPOSITORY || 'dr-rei/VaultBack');
const tag = value('tag', `v${version}`);
const output = path.resolve(value('output', 'latest.json'));
const channel = value('channel', 'stable');
const releaseNotesUrl = value('release-notes-url', `https://github.com/${repository}/releases/tag/${tag}`);
const baseDownloadUrl = value('base-download-url', `https://github.com/${repository}/releases/download/${tag}`);

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Use a semantic version such as 1.2.3 with --version.');
if (!/^https:\/\//i.test(baseDownloadUrl)) throw new Error('--base-download-url must use HTTPS.');

const artifacts = {};
for (const specification of artifactArguments()) {
  const [platform, archive] = String(specification).split('=', 2);
  if (!platform || !archive) throw new Error(`Invalid artifact '${specification}'. Use platform-arch=archive.tar.gz.`);
  const file = path.resolve(archive);
  if (!fs.existsSync(file)) throw new Error(`Artifact does not exist: ${file}`);
  const stat = fs.statSync(file);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  artifacts[platform] = { url: `${baseDownloadUrl}/${path.basename(file)}`, sha256: hash, bytes: stat.size };
}

if (!Object.keys(artifacts).length) throw new Error('At least one --artifact platform-arch=archive.tar.gz is required.');
function compareVersions(left, right) {
  const parse = value => String(value).replace(/^v/, '').split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0);
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index += 1) if ((a[index] || 0) !== (b[index] || 0)) return (b[index] || 0) - (a[index] || 0);
  return 0;
}
function releaseTags() {
  try { return execFileSync('git', ['tag', '--list', 'v*.*.*'], { encoding: 'utf8' }).split(/\r?\n/).map(item => item.replace(/^v/, '')).filter(item => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item)); } catch { return []; }
}
const releaseVersions = [...new Set([version, ...releaseTags()])].sort(compareVersions);
const releases = releaseVersions.map(releaseVersion => ({ version: releaseVersion, releaseNotesUrl: `https://github.com/${repository}/releases/tag/v${releaseVersion}` }));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ version, channel, publishedAt: new Date().toISOString(), releaseNotesUrl, releases, artifacts }, null, 2)}\n`);
console.log(`Wrote ${output}`);
