import { Injectable, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { types } from 'node:util';
import { DataOwner } from './data-owner';

class StatementWrapper {
  constructor(private readonly database: SqliteFile, private readonly sql: string) {}
  get(...params: unknown[]) { return this.database.queryOne(this.sql, params); }
  all(...params: unknown[]) { return this.database.queryAll(this.sql, params); }
  run(...params: unknown[]) { return this.database.execute(this.sql, params); }
}

export class SqliteFile {
  private transactionDepth = 0;
  private opened = false;
  private native!: SqlJsDatabase;
  constructor(private readonly filePath: string) {}
  open(native: SqlJsDatabase) { this.native = native; this.opened = true; }
  prepare(sql: string) { return new StatementWrapper(this, sql); }
  exec(sql: string) { this.transaction(() => { this.native.run(sql); }); }
  queryOne(sql: string, params: unknown[]) { const rows = this.queryAll(sql, params); return rows[0]; }
  queryAll(sql: string, params: unknown[]) {
    const statement = this.native.prepare(sql); statement.bind(params as any); const rows: Record<string, unknown>[] = [];
    try { while (statement.step()) rows.push(statement.getAsObject() as Record<string, unknown>); return rows; }
    finally { statement.free(); }
  }
  execute(sql: string, params: unknown[]) {
    return this.transaction(() => { this.native.run(sql, params as any); return { changes: this.native.getRowsModified() }; });
  }
  transaction<T>(work: () => T): T {
    // Reject native async callbacks before they can schedule writes after an await.
    if (types.isAsyncFunction(work)) throw new Error('SQLite transactions must be synchronous');
    // Each level owns a snapshot so a caught inner failure cannot leak partial writes.
    const before = this.native.export();
    this.transactionDepth++;
    try {
      const value = work();
      if (value && typeof (value as any).then === 'function') throw new Error('SQLite transactions must be synchronous');
      if (this.transactionDepth === 1) this.persist();
      return value;
    } catch (error) {
      this.native.close();
      const Constructor = this.native.constructor as new (bytes: Uint8Array) => SqlJsDatabase;
      this.native = new Constructor(before);
      throw error;
    } finally { this.transactionDepth--; }
  }
  persist() {
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      const mode = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).mode & 0o777 : 0o600;
      fd = fs.openSync(temporary, 'wx', mode);
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, Buffer.from(this.native.export())); fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, this.filePath);
      // Rename has committed. Directory sync is best effort (unsupported on Windows);
      // a sync failure must not restore memory to the pre-commit database.
      let directoryFd: number | undefined;
      try { directoryFd = fs.openSync(path.dirname(this.filePath), 'r'); fs.fsyncSync(directoryFd); }
      catch { /* Filesystem does not support directory fsync. */ }
      finally { if (directoryFd !== undefined) { try { fs.closeSync(directoryFd); } catch {} } }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
  close(persist = true) { if (this.opened) { if (persist) this.persist(); this.native.close(); this.opened = false; } }
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private releaseOwner?: () => void;
  private readonly beforeCloseHooks: (() => Promise<void>)[] = [];
  registerBeforeClose(hook: () => Promise<void>) { this.beforeCloseHooks.push(hook); }
  private readonly dbFile = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'vaultback.sqlite');
  readonly db = new SqliteFile(this.dbFile);
  readonly dataDir = path.dirname(this.dbFile);
  private encryptionCheck: { status: 'ok' | 'error'; message: string; checkedRecords: number; checkedAt: string } = { status: 'ok', message: 'Encryption integrity has not been checked yet', checkedRecords: 0, checkedAt: '' };

  async onModuleInit() {
    this.releaseOwner = DataOwner.acquire(this.dataDir);
    try {
      fs.mkdirSync(this.dataDir, { recursive: true }); fs.mkdirSync(path.join(this.dataDir, 'tmp'), { recursive: true }); this.applyPendingImport();
      const SQL = await initSqlJs({ locateFile: file => require.resolve(`sql.js/dist/${file}`) });
      const native = fs.existsSync(this.dbFile) ? new SQL.Database(new Uint8Array(fs.readFileSync(this.dbFile))) : new SQL.Database();
      this.db.open(native);
      if (fs.existsSync(this.dbFile) && !this.db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'backup_executions')) {
        const backup = `${this.dbFile}.before-executions.bak`;
        if (!fs.existsSync(backup)) fs.copyFileSync(this.dbFile, backup, fs.constants.COPYFILE_EXCL);
      }
      this.db.transaction(() => this.migrate()); this.getEncryptionKey(); this.checkEncryptionKey();
      try { fs.chmodSync(this.dbFile, 0o600); fs.chmodSync(this.dataDir, 0o700); } catch {}

    } catch (error) { this.db.close(false); this.releaseOwner?.(); this.releaseOwner = undefined; throw error; }
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setup_claims (id INTEGER PRIMARY KEY CHECK (id = 1), claimed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, last_login_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS database_connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, engine TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL, password_enc TEXT NOT NULL, database_name TEXT NOT NULL, database_scope TEXT NOT NULL DEFAULT 'selected', database_names TEXT NOT NULL DEFAULT '[]', ssl INTEGER NOT NULL DEFAULT 0, connection_purpose TEXT NOT NULL DEFAULT 'backup', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS storage_targets (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config_enc TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_jobs (id TEXT PRIMARY KEY, name TEXT NOT NULL, database_connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE, storage_target_id TEXT NOT NULL REFERENCES storage_targets(id) ON DELETE CASCADE, database_scope TEXT NOT NULL DEFAULT 'selected', database_names TEXT NOT NULL DEFAULT '[]', backup_layout TEXT NOT NULL DEFAULT 'single', backup_objects TEXT NOT NULL DEFAULT '{}', insert_mode TEXT NOT NULL DEFAULT 'extended', cron_expression TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'UTC', enabled INTEGER NOT NULL DEFAULT 1, compression TEXT NOT NULL DEFAULT 'gzip', backup_encryption TEXT NOT NULL DEFAULT 'none', retention_count INTEGER NOT NULL DEFAULT 7, retry_count INTEGER NOT NULL DEFAULT 0, retry_delay_seconds INTEGER NOT NULL DEFAULT 300, overlap_policy TEXT NOT NULL DEFAULT 'skip', filename_prefix TEXT NOT NULL, next_run_at TEXT, last_run_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, filename TEXT, storage_location TEXT, storage_folder TEXT, storage_target_id TEXT, database_connection_id TEXT, database_names TEXT, database_scope TEXT, size_bytes INTEGER, sha256 TEXT, verification_status TEXT, verification_message TEXT, restore_verification_status TEXT, restore_verification_message TEXT, error_message TEXT, attempt INTEGER NOT NULL DEFAULT 1, backup_layout TEXT, backup_objects TEXT, expected_objects TEXT, compression TEXT, backup_encryption TEXT, insert_mode TEXT, connection_engine TEXT, pitr_log_file TEXT, pitr_log_position INTEGER, pitr_coordinate_at TEXT);
      CREATE TABLE IF NOT EXISTS work_claims (claim_key TEXT PRIMARY KEY, claim_token TEXT NOT NULL, process_id INTEGER NOT NULL, claimed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verification_reports (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE, kind TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS storage_health (target_id TEXT PRIMARY KEY REFERENCES storage_targets(id) ON DELETE CASCADE, status TEXT NOT NULL, message TEXT NOT NULL, latency_ms INTEGER, checked_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_job_connections (job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE, connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE, database_names TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (job_id, connection_id));
      CREATE TABLE IF NOT EXISTS backup_job_storages (job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE, storage_target_id TEXT NOT NULL REFERENCES storage_targets(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (job_id, storage_target_id));
      CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_plans (id TEXT PRIMARY KEY, name TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE, destination_connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE, cron_expression TEXT NOT NULL DEFAULT '0 4 * * 0', timezone TEXT NOT NULL DEFAULT 'UTC', enabled INTEGER NOT NULL DEFAULT 1, test_database_prefix TEXT NOT NULL DEFAULT 'vaultback_recovery_test', last_test_at TEXT, next_test_at TEXT, last_status TEXT, last_message TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_tests (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES recovery_plans(id) ON DELETE CASCADE, source_run_id TEXT REFERENCES backup_runs(id) ON DELETE SET NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, test_database_name TEXT, destination_connection_id TEXT, rpo_seconds INTEGER, rto_seconds INTEGER, objects_expected INTEGER, objects_restored INTEGER, evidence_json TEXT NOT NULL DEFAULT '{}', error_message TEXT);
      CREATE TABLE IF NOT EXISTS artifact_rehearsals (id TEXT PRIMARY KEY, backup_run_id TEXT NOT NULL, recovery_connection_id TEXT NOT NULL, actor_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, evidence_json TEXT NOT NULL DEFAULT '{}', error_message TEXT);
      CREATE TABLE IF NOT EXISTS pitr_sources (connection_id TEXT PRIMARY KEY REFERENCES database_connections(id) ON DELETE CASCADE, storage_target_id TEXT REFERENCES storage_targets(id) ON DELETE SET NULL, enabled INTEGER NOT NULL DEFAULT 0, capture_interval_minutes INTEGER NOT NULL DEFAULT 15, last_scan_at TEXT, last_capture_at TEXT, binlog_status TEXT NOT NULL DEFAULT 'unknown', earliest_binlog_at TEXT, latest_binlog_at TEXT, checkpoint_json TEXT NOT NULL DEFAULT '{}', gap_status TEXT NOT NULL DEFAULT 'unknown', message TEXT NOT NULL DEFAULT 'Not checked', base_job_id TEXT REFERENCES backup_jobs(id) ON DELETE SET NULL, next_capture_at TEXT, last_continuous_at TEXT);
      CREATE TABLE IF NOT EXISTS pitr_artifacts (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE, storage_target_id TEXT NOT NULL REFERENCES storage_targets(id) ON DELETE CASCADE, binlog_name TEXT NOT NULL, storage_location TEXT, storage_folder TEXT NOT NULL, size_bytes INTEGER, sha256 TEXT, captured_at TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', capture_id TEXT, capture_kind TEXT NOT NULL DEFAULT 'manual', log_position INTEGER, log_size INTEGER, UNIQUE(connection_id, storage_target_id, binlog_name, storage_folder));
      CREATE TABLE IF NOT EXISTS pitr_rehearsals (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE, backup_run_id TEXT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE, recovery_connection_id TEXT NOT NULL REFERENCES database_connections(id) ON DELETE CASCADE, target_time TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT 'queued', started_at TEXT NOT NULL, finished_at TEXT, evidence_json TEXT NOT NULL DEFAULT '{}', error_message TEXT);
      CREATE TABLE IF NOT EXISTS fleet_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, installation_id TEXT NOT NULL UNIQUE, enrollment_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', last_seen_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_runs_job_started ON backup_runs(job_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON backup_jobs(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_recovery_tests_plan_started ON recovery_tests(plan_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_recovery_plans_next_test ON recovery_plans(enabled, next_test_at);
      CREATE INDEX IF NOT EXISTS idx_pitr_artifacts_connection_captured ON pitr_artifacts(connection_id, captured_at DESC);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1 CHECK(concurrency BETWEEN 1 AND 8), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backup_executions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', scheduled_for TEXT, queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, parent_execution_id TEXT, actor_id TEXT, priority INTEGER NOT NULL DEFAULT 0, enqueue_sequence INTEGER, snapshot_json TEXT NOT NULL DEFAULT '{}', cleanup_warnings_json TEXT NOT NULL DEFAULT '[]', missed_count INTEGER NOT NULL DEFAULT 0, missed_from TEXT, missed_to TEXT, UNIQUE(job_id, scheduled_for));
      CREATE TABLE IF NOT EXISTS backup_execution_pairs (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES backup_executions(id), connection_id TEXT NOT NULL, storage_target_id TEXT NOT NULL, fingerprint TEXT NOT NULL, source_group_id TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'queued', wait_reason TEXT, snapshot_json TEXT NOT NULL DEFAULT '{}', next_attempt_at TEXT, started_at TEXT, finished_at TEXT, cleanup_warnings_json TEXT NOT NULL DEFAULT '[]', UNIQUE(execution_id, connection_id, storage_target_id));
      CREATE TABLE IF NOT EXISTS backup_execution_attempts (id TEXT PRIMARY KEY, pair_id TEXT NOT NULL REFERENCES backup_execution_pairs(id), attempt_number INTEGER NOT NULL, status TEXT NOT NULL, backup_run_id TEXT, started_at TEXT, finished_at TEXT, failed_stage TEXT, error_message TEXT, cleanup_warnings_json TEXT NOT NULL DEFAULT '[]', UNIQUE(pair_id, attempt_number));
      CREATE TABLE IF NOT EXISTS execution_events (id TEXT PRIMARY KEY, execution_id TEXT, pair_id TEXT, kind TEXT NOT NULL, actor_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_outbox (id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, execution_id TEXT, incident_id TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS protection_incidents (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, connection_id TEXT NOT NULL, storage_target_id TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', opened_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT, evidence_json TEXT NOT NULL DEFAULT '{}');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_protection_open ON protection_incidents(job_id, connection_id, storage_target_id, fingerprint, kind) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS idx_execution_queue ON backup_executions(status, priority, enqueue_sequence);
      CREATE INDEX IF NOT EXISTS idx_attempt_pair ON backup_execution_attempts(pair_id, attempt_number);
    `);
    const additions: [string, string, string][] = [
      ['storage_health', 'free_bytes', 'INTEGER'],
      ['database_connections', 'source_group_id', 'TEXT'],
      ['backup_job_storages', 'required', 'INTEGER NOT NULL DEFAULT 1 CHECK(required IN (0,1))'],
      ['backup_jobs', 'missed_start_grace_minutes', 'INTEGER NOT NULL DEFAULT 15 CHECK(missed_start_grace_minutes BETWEEN 1 AND 1440)'],
      ['backup_jobs', 'max_verified_age_hours', 'INTEGER NOT NULL DEFAULT 26 CHECK(max_verified_age_hours BETWEEN 1 AND 8760)'],
      ['backup_jobs', 'long_running_warning_minutes', 'INTEGER NOT NULL DEFAULT 120 CHECK(long_running_warning_minutes BETWEEN 1 AND 10080)'],
      ['backup_runs', 'execution_id', 'TEXT'], ['backup_runs', 'attempt_id', 'TEXT']
    ];
    for (const [table, column, definition] of additions) {
      if (!(this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some(row => row.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(20261031, this.now());
    try { this.db.exec("ALTER TABLE database_connections ADD COLUMN database_scope TEXT NOT NULL DEFAULT 'selected'"); } catch {}
    try { this.db.exec("ALTER TABLE database_connections ADD COLUMN database_names TEXT NOT NULL DEFAULT '[]'"); } catch {}
    try { this.db.exec("ALTER TABLE database_connections ADD COLUMN connection_purpose TEXT NOT NULL DEFAULT 'backup'"); } catch {}
    try { this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN database_scope TEXT NOT NULL DEFAULT 'selected'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN database_names TEXT NOT NULL DEFAULT '[]'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN backup_layout TEXT NOT NULL DEFAULT 'single'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN backup_objects TEXT NOT NULL DEFAULT '{}'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN insert_mode TEXT NOT NULL DEFAULT 'extended'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN backup_encryption TEXT NOT NULL DEFAULT 'none'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN verification_status TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN verification_message TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN storage_location TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN storage_folder TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN storage_target_id TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN database_connection_id TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN database_names TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN database_scope TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN retry_delay_seconds INTEGER NOT NULL DEFAULT 300"); } catch {}
    try { this.db.exec("ALTER TABLE backup_jobs ADD COLUMN overlap_policy TEXT NOT NULL DEFAULT 'skip'"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN restore_verification_status TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN restore_verification_message TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE backup_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1"); } catch {}
    try { this.db.exec('ALTER TABLE backup_runs ADD COLUMN backup_layout TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE backup_runs ADD COLUMN backup_objects TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE backup_runs ADD COLUMN expected_objects TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE backup_runs ADD COLUMN compression TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE backup_runs ADD COLUMN backup_encryption TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE backup_runs ADD COLUMN insert_mode TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE backup_runs ADD COLUMN connection_engine TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE backup_runs ADD COLUMN pitr_log_file TEXT'); } catch {}
    try { this.db.exec('ALTER TABLE backup_runs ADD COLUMN pitr_log_position INTEGER'); } catch {}
    try { this.db.exec('ALTER TABLE backup_runs ADD COLUMN pitr_coordinate_at TEXT'); } catch {}
    try { this.db.exec("INSERT OR IGNORE INTO backup_job_connections (job_id,connection_id,database_names,position) SELECT id,database_connection_id,database_names,0 FROM backup_jobs WHERE database_connection_id IS NOT NULL"); } catch {}
    try { this.db.exec("INSERT OR IGNORE INTO backup_job_storages (job_id,storage_target_id,position) SELECT id,storage_target_id,0 FROM backup_jobs WHERE storage_target_id IS NOT NULL"); } catch {}
    try { this.db.exec("ALTER TABLE pitr_sources ADD COLUMN storage_target_id TEXT REFERENCES storage_targets(id) ON DELETE SET NULL"); } catch {}
    try { this.db.exec("ALTER TABLE pitr_sources ADD COLUMN capture_interval_minutes INTEGER NOT NULL DEFAULT 15"); } catch {}
    try { this.db.exec("ALTER TABLE pitr_sources ADD COLUMN last_capture_at TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE pitr_sources ADD COLUMN base_job_id TEXT REFERENCES backup_jobs(id) ON DELETE SET NULL"); } catch {}
    try { this.db.exec("ALTER TABLE pitr_sources ADD COLUMN next_capture_at TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE pitr_sources ADD COLUMN last_continuous_at TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE pitr_artifacts ADD COLUMN capture_id TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE pitr_artifacts ADD COLUMN capture_kind TEXT NOT NULL DEFAULT 'manual'"); } catch {}
    try { this.db.exec("ALTER TABLE pitr_artifacts ADD COLUMN log_position INTEGER"); } catch {}
    try { this.db.exec("ALTER TABLE pitr_artifacts ADD COLUMN log_size INTEGER"); } catch {}
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
  onModuleDestroy(): void | Promise<void> {
    const close = () => { this.db.close(); this.releaseOwner?.(); this.releaseOwner = undefined; };
    if (!this.beforeCloseHooks.length) { close(); return; }
    return (async () => { for (const hook of this.beforeCloseHooks) await hook(); close(); })();
  }
}
