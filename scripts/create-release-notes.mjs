import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);

function argument(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? String(args[index + 1] || fallback) : fallback;
}

const version = argument('version', process.env.GITHUB_REF_NAME || '').replace(/^v/, '');
const tag = argument('tag', process.env.GITHUB_REF_NAME || `v${version}`);
const output = argument('output', 'release/RELEASE_NOTES.md');

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Use a semantic version such as 1.2.3 with --version.');

function git(parameters, fallback = '') {
  try { return execFileSync('git', parameters, { encoding: 'utf8' }).trim(); } catch { return fallback; }
}

const previousTag = argument(
  'previous-tag',
  git(['describe', '--tags', '--abbrev=0', `${tag}^`], '') ||
    git(['tag', '--sort=-version:refname'], '').split(/\r?\n/).find(candidate => candidate && candidate !== tag) ||
    ''
);
const range = previousTag ? `${previousTag}..${tag}` : tag;
const commits = git(['log', range, '--format=%s'], '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const groups = new Map([
  ['feat', ['New features']],
  ['fix', ['Bug fixes']],
  ['security', ['Security']],
  ['perf', ['Performance']],
  ['docs', ['Documentation']],
  ['refactor', ['Improvements']],
  ['chore', ['Maintenance']]
]);
const categorized = new Map([...groups.values()].map(([label]) => [label, []]));
const other = [];

for (const subject of commits) {
  const match = subject.match(/^([A-Za-z]+)(?:\([^)]*\))?!?:\s*(.+)$/);
  const group = match ? groups.get(match[1].toLowerCase()) : null;
  (group ? categorized.get(group[0]) : other).push(match ? match[2] : subject);
}

const sections = [];
for (const [label, entries] of categorized) {
  if (entries.length) sections.push(`## ${label}\n\n${entries.map(item => `- ${item}`).join('\n')}`);
}
if (other.length) sections.push(`## Other changes\n\n${other.map(item => `- ${item}`).join('\n')}`);

const notes = [
  `# VaultBack v${version}`,
  '',
  'This release contains the changes listed below. The application update preserves `data/`, `.env`, encryption keys, portable database tools, and backup artifacts.',
  '',
  sections.length ? sections.join('\n\n') : '## Changes\n\n- Maintenance release.',
  '',
  '## Upgrade notes',
  '',
  '- Use the administrator update panel or the platform-specific release installer.',
  '- aaPanel users should use the install-only installer, then restart the PM2 project from the aaPanel GUI.',
  '- Back up `data/` and `.env` before upgrading and keep `APP_ENCRYPTION_KEY` unchanged.',
  '',
  `Full changelog: https://github.com/${process.env.GITHUB_REPOSITORY || 'dr-rei/VaultBack'}/compare/${previousTag || 'v0.0.0'}...${tag}`,
  ''
].join('\n');

fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, notes);
console.log(`Wrote ${output}`);
