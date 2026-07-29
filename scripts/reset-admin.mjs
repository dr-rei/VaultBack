import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import bcrypt from 'bcryptjs';

const require = createRequire(import.meta.url);
const projectDir = process.cwd();
const args = new Set(process.argv.slice(2));
const force = args.has('--force') || args.has('-f');

function envValue(name) {
  if (process.env[name]) return process.env[name];
  const envPath = path.join(projectDir, '.env');
  if (!fs.existsSync(envPath)) return '';
  const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find(value => new RegExp(`^\\s*${name}\\s*=`).test(value));
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') : '';
}

function ask(question) {
  return new Promise(resolve => {
    const prompt = readline.createInterface({ input, output });
    prompt.question(question, answer => { prompt.close(); resolve(answer.trim()); });
  });
}

function askSecret(question) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return ask(question);
  return new Promise((resolve, reject) => {
    let answer = '';
    const onData = chunk => {
      for (const character of String(chunk)) {
        if (character === '\u0003') { cleanup(); reject(new Error('Cancelled.')); return; }
        if (character === '\r' || character === '\n') { output.write('\n'); cleanup(); resolve(answer); return; }
        if (character === '\u0008' || character === '\u007f') { answer = answer.slice(0, -1); continue; }
        answer += character;
      }
    };
    const cleanup = () => { input.setRawMode(false); input.pause(); input.removeListener('data', onData); };
    output.write(question);
    input.setRawMode(true); input.resume(); input.on('data', onData);
  });
}

function firstRow(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const row = statement.step() ? statement.getAsObject() : null;
  statement.free();
  return row;
}

const configuredDataDir = envValue('DATA_DIR') || path.join(projectDir, 'data');
const dataDir = path.resolve(projectDir, configuredDataDir);
const projectRoot = path.resolve(projectDir);
const dbFile = path.join(dataDir, 'vaultback.sqlite');
const root = path.parse(dataDir).root;

if (dataDir === root || dataDir === projectRoot || projectRoot.startsWith(`${dataDir}${path.sep}`)) {
  console.error(`Refusing to use unsafe DATA_DIR: ${dataDir}`);
  process.exit(1);
}
if (!fs.existsSync(dbFile)) {
  console.error(`Vaultback database not found: ${dbFile}`);
  console.error('There is no administrator account to reset. Start the app and complete first-time setup.');
  process.exit(1);
}

let username = process.env.RESET_ADMIN_USERNAME || '';
let password = process.env.RESET_ADMIN_PASSWORD || '';
if (!username) username = await ask('New administrator username: ');
if (!password) password = await askSecret('New administrator password: ');
if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw new Error('Username must be 3-40 characters and use only letters, numbers, _, ., or -.');
if (password.length < 12) throw new Error('Password must contain at least 12 characters.');

const SQL = await initSqlJs({ locateFile: file => path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.js')), file) });
const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbFile)));
try {
  const admin = firstRow(db, 'SELECT id, username FROM users WHERE role = ? ORDER BY created_at ASC LIMIT 1', ['admin']);
  if (!admin) throw new Error('No administrator account exists in the Vaultback database.');
  const duplicate = firstRow(db, 'SELECT id FROM users WHERE username = ? AND id <> ?', [username, admin.id]);
  if (duplicate) throw new Error(`Username "${username}" is already used by another account.`);

  console.log(`Administrator account selected: ${admin.username}`);
  console.log(`Database: ${dbFile}`);
  console.log('All existing sessions will be logged out. Connections, schedules, storage, and backups will remain unchanged.');
  if (!force && (await ask('Type RESET ADMIN to continue: ')) !== 'RESET ADMIN') {
    console.log('Cancelled.');
    process.exit(0);
  }

  const hash = await bcrypt.hash(password, 12);
  db.run('UPDATE users SET username = ?, password_hash = ?, role = ?, last_login_at = NULL WHERE id = ?', [username, hash, 'admin', admin.id]);
  db.run('DELETE FROM sessions');
  fs.writeFileSync(dbFile, Buffer.from(db.export()), { mode: 0o600 });
  console.log(`Administrator credentials updated. Log in as "${username}" after restarting the app.`);
} finally {
  db.close();
}
