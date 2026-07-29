import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const projectDir = process.cwd();
const args = new Set(process.argv.slice(2));
const force = args.has('--force') || args.has('-f');
const dryRun = args.has('--dry-run');

function envValue(name) {
  if (process.env[name]) return process.env[name];
  const envPath = path.join(projectDir, '.env');
  if (!fs.existsSync(envPath)) return '';
  const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find(value => new RegExp(`^\\s*${name}\\s*=`).test(value));
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') : '';
}

const configuredDataDir = envValue('DATA_DIR') || path.join(projectDir, 'data');
const dataDir = path.resolve(projectDir, configuredDataDir);
const projectRoot = path.resolve(projectDir);
const root = path.parse(dataDir).root;

if (dataDir === root || dataDir === projectRoot || projectRoot.startsWith(`${dataDir}${path.sep}`)) {
  console.error(`Refusing to reset unsafe DATA_DIR: ${dataDir}`);
  process.exit(1);
}

const targets = [
  'vaultback.sqlite',
  'vaultback.sqlite-wal',
  'vaultback.sqlite-shm',
  'vaultback.pending.sqlite',
  '.encryption-key',
  '.encryption-key.pending',
  'backups',
  'tmp'
].map(name => path.join(dataDir, name));

const existing = targets.filter(target => fs.existsSync(target));
console.log(`Vaultback data directory: ${dataDir}`);
if (!existing.length) {
  console.log('Already clean. No application data was found.');
  process.exit(0);
}

console.log('This will permanently remove:');
for (const target of existing) console.log(`  - ${path.relative(projectDir, target) || target}`);
console.log('It will not remove the project, node_modules, or .env.');

if (dryRun) {
  console.log('Dry run only; nothing was removed.');
  process.exit(0);
}

if (!force) {
  const prompt = readline.createInterface({ input, output });
  const answer = await prompt.question('Type RESET to continue: ');
  prompt.close();
  if (answer.trim() !== 'RESET') {
    console.log('Cancelled.');
    process.exit(0);
  }
}

for (const target of existing) fs.rmSync(target, { recursive: true, force: true });
console.log('Vaultback data reset complete. Restart the app and it will show the first-time setup screen.');
