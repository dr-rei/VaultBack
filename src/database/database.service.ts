import { Injectable, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

class StatementWrapper {
  constructor(private readonly database: SqliteFile, private readonly sql: string) {}
  get(...params: unknown[]) { return this.database.queryOne(this.sql, params); }
  all(...params: unknown[]) { return this.database.queryAll(this.sql, params); }
  run(...params: unknown[]) { return this.database.execute(this.sql, params); }
}

class SqliteFile {
  private native!: SqlJsDatabase;
  constructor(private readonly filePath: string) {}
  open(native: SqlJsDatabase) { this.native = native; }
  prepare(sql: string) { return new StatementWrapper(this, sql); }
  exec(sql: string) { this.native.run(sql); this.persist(); }
  queryOne(sql: string, params: unknown[]) { const rows = this.queryAll(sql, params); return rows[0]; }
  queryAll(sql: string, params: unknown[]) {
    const statement = this.native.prepare(sql); statement.bind(params as any); const rows: Record<string, unknown>[] = [];
    while (statement.step()) rows.push(statement.getAsObject() as Record<string, unknown>);
    statement.free(); return rows;
  }
  execute(sql: string, params: unknown[]) {
    this.native.run(sql, params as any); const changes = this.native.getRowsModified(); this.persist(); return { changes };
  }
  persist() { fs.writeFileSync(this.filePath, Buffer.from(this.native.export())); }
  close() { if (this.native) { this.persist(); this.native.close(); } }
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly db = new SqliteFile(path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'vaultback.sqlite'));
  readonly dataDir = path.dirname(this.dbFile);
  private encryptionCheck: { status: 'ok' | 'error'; message: string; checkedRecords: number; checkedAt: string } = { status: 'ok', message: 'Encryption integrity has not been checked yet', checkedRecords: 0, checkedAt: '' };
  private get dbFile() { return path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'vaultback.sqlite'); }

  async onModuleInit() {
    fs.mkdirSync(this.dataDir, { recursive: true }); fs.mkdirSync(path.join(this.dataDir, 'tmp'), { recursive: true }); this.applyPendingImport();
    const SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
    const native = fs.existsSync(this.dbFile) ? new SQL.Database(new Uint8Array(fs.readFileSync(this.dbFile))) : new SQL.Database();
    this.db.open(native); this.migrate(); this.checkEncryptionKey();
    try { fs.chmodSync(this.dbFile, 0o600); fs.chmodSync(this.dataDir, 0o700); } catch {}
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setup_claims (id INTEGER PRIMARY KEY CHECK (id = 1), claimed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, last_login_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS database_connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, engine TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, password_enc TEXT NOT NULL, database_name TEXT NOT NULL, database_scope TEXT NOT NULL DEFAULT 'selected', database_names TEXT NOT NULL DEFAULT '[]', ssl INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS storage_targets (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config_enc TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_jobs (id TEXT PRIMARY KEY, name TEXT NOT NULL, database_connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE, storage_target_id TEXT NOT NULL REFERENCES storage_targets(id) ON DELETE CASCADE, database_scope TEXT NOT NULL DEFAULT 'selected', database_names TEXT NOT NULL DEFAULT '[]', backup_layout TEXT NOT NULL DEFAULT 'single', backup_objects TEXT NOT NULL DEFAULT '{}', cron_expression TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'UTC', enabled INTEGER NOT NULL DEFAULT 1, compression TEXT NOT NULL DEFAULT 'gzip', backup_encryption TEXT NOT NULL DEFAULT 'none', retention_count INTEGER NOT NULL DEFAULT 7, retry_count INTEGER NOT NULL DEFAULT 0, retry_delay_seconds INTEGER NOT NULL DEFAULT 300, overlap_policy TEXT NOT NULL DEFAULT 'skip', filename_prefix TEXT NOT NULL, next_run_at TEXT, last_run_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, filename TEXT, storage_location TEXT, storage_folder TEXT, size_bytes INTEGER, sha256 TEXT, verification_status TEXT, verification_message TEXT, restore_verification_status TEXT, restore_verification_message TEXT, error_message TEXT, attempt INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS verification_reports (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE, kind TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS storage_health (target_id TEXT PRIMARY KEY REFERENCES storage_targets(id) ON DELETE CASCADE, status TEXT NOT NULL, message TEXT NOT NULL, latency_ms INTEGER, checked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_runs_job_started ON backup_runs(job_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON backup_jobs(enabled, next_run_at);
    `);
    try { this.db.exec("ALTER TABLE database_connections ADD COLUMN database_scope TEXT NOT NULL DEFAULT 'selected'"); } catch {}
    try { this.db.exec("ALTER TABLE database_connections ADD COLUMN database_names TEXT NOT NULL DEFAULT '[]'"); } catch {}
    try { this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN database_scope TEXT NOT NULL DEFAULT 'selected'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN database_names TEXT NOT NULL DEFAULT '[]'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN backup_layout TEXT NOT NULL DEFAULT 'single'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN backup_objects TEXT NOT NULL DEFAULT '{}'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN backup_encryption TEXT NOT NULL DEFAULT 'none'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN verification_status TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN verification_message TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN storage_location TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN storage_folder TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN retry_delay_seconds INTEGER NOT NULL DEFAULT 300"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN overlap_policy TEXT NOT NULL DEFAULT 'skip'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN restore_verification_status TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN restore_verification_message TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1"); } catch {}
  }

  encrypt(value: unknown): string {
    const key = this.getEncryptionKey(); const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
  }
  decrypt<T>(encoded: string): T {
    const [ivText, tagText, bodyText] = encoded.split('.'); if (!ivText || !tagText || !bodyText) throw new Error('Encrypted configuration is malformed');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.getEncryptionKey(), Buffer.from(ivText, 'base64url')); decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const body = Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64url')), decipher.final()]); return JSON.parse(body.toString('utf8')) as T;
  }
  encryptionStatus() { return { ...this.encryptionCheck }; }
  assertEncryptionHealthy() {
    if (this.encryptionCheck.status === 'error') throw new ServiceUnavailableException(this.encryptionCheck.message);
  }
  private checkEncryptionKey() {
    const encryptedValues = [
      ...(this.db.prepare('SELECT password_enc as value FROM database_connections WHERE password_enc IS NOT NULL LIMIT 1').all() as any[]),
      ...(this.db.prepare('SELECT config_enc as value FROM storage_targets WHERE config_enc IS NOT NULL LIMIT 1').all() as any[]),
      ...(this.db.prepare('SELECT value FROM app_settings WHERE value IS NOT NULL LIMIT 1').all() as any[])
    ];
    try {
      for (const row of encryptedValues) this.decrypt(row.value);
      this.encryptionCheck = { status: 'ok', message: encryptedValues.length ? 'Stored encrypted configuration can be decrypted' : 'No encrypted configuration exists yet', checkedRecords: encryptedValues.length, checkedAt: this.now() };
    } catch {
      this.encryptionCheck = { status: 'error', message: 'The encryption key is missing or does not match the stored configuration. Restore the original APP_ENCRYPTION_KEY or data/.encryption-key before using saved credentials.', checkedRecords: encryptedValues.length, checkedAt: this.now() };
    }
  }
  private getEncryptionKey(): Buffer {
    const configured = process.env.APP_ENCRYPTION_KEY; const keyPath = path.join(this.dataDir, '.encryption-key'); let value = configured || (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8').trim() : '');
    if (!value) { value = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(keyPath, value, { encoding: 'utf8', mode: 0o600 }); }
    try { fs.chmodSync(keyPath, 0o600); fs.chmodSync(this.dataDir, 0o700); } catch {}
    return crypto.createHash('sha256').update(value).digest();
  }
  databaseFilePath() { return this.dbFile; }
  encryptionKeyValue() { const configured = process.env.APP_ENCRYPTION_KEY; const keyPath = path.join(this.dataDir, '.encryption-key'); return configured || (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8').trim() : ''); }
  stageImportedDatabase(database: Buffer, encryptionKey: string) { const pendingDatabase = path.join(this.dataDir, 'vaultback.pending.sqlite'); const pendingKey = path.join(this.dataDir, '.encryption-key.pending'); fs.writeFileSync(pendingDatabase, database, { mode: 0o600 }); fs.writeFileSync(pendingKey, encryptionKey, { encoding: 'utf8', mode: 0o600 }); }
  private applyPendingImport() { const pendingDatabase = path.join(this.dataDir, 'vaultback.pending.sqlite'); const pendingKey = path.join(this.dataDir, '.encryption-key.pending'); if (!fs.existsSync(pendingDatabase) || !fs.existsSync(pendingKey)) return; fs.copyFileSync(pendingDatabase, this.dbFile); fs.copyFileSync(pendingKey, path.join(this.dataDir, '.encryption-key')); fs.rmSync(pendingDatabase, { force: true }); fs.rmSync(pendingKey, { force: true }); }
  deriveKey(purpose: string) { return crypto.createHmac('sha256', this.getEncryptionKey()).update(purpose).digest(); }
  now() { return new Date().toISOString(); }
  onModuleDestroy() { this.db.close(); }
}
