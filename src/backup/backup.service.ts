import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { DatabaseService } from '../database/database.service';
import { BackupJob, DatabaseConnection, StorageTarget } from '../types';
import { ensureDirectory, nextCron, safeFilePart } from './backup.utils';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createDecipheriv, createCipheriv } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { SystemService } from '../system/system.service';
import { createConnection } from 'mysql2/promise';

type ProcessStage = 'preparing' | 'dumping' | 'compressing' | 'encrypting' | 'verifying' | 'uploading' | 'rotating' | 'completed' | 'failed';
type LiveBackupProcess = {
  id: string;
  jobId: string;
  jobName: string;
  status: 'running' | 'success' | 'failed';
  stage: ProcessStage;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  logs: string[];
};

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private readonly running = new Set<string>();
  private readonly liveProcessState = new Map<string, LiveBackupProcess>();
  constructor(private readonly store: DatabaseService, private readonly storage: StorageService, private readonly system: SystemService) {}

  private pageOptions(input: any = {}) { const page = Math.max(1, Number.parseInt(String(input.page || '1'), 10) || 1); const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(input.pageSize || '25'), 10) || 25)); return { page, pageSize, offset: (page - 1) * pageSize, search: String(input.search || '').trim().toLowerCase() }; }
  private pageResult(items: any[], total: number, page: number, pageSize: number, extra: Record<string, unknown> = {}) { return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), ...extra }; }

  listConnectionsPage(input: any = {}) {
    const { page, pageSize, offset, search } = this.pageOptions(input); const where = search ? `WHERE LOWER(COALESCE(name,'') || ' ' || COALESCE(engine,'') || ' ' || COALESCE(host,'') || ' ' || COALESCE(username,'') || ' ' || COALESCE(database_name,'')) LIKE ?` : ''; const params = search ? [`%${search}%`] : []; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM database_connections ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT id, name, engine, host, port, username, database_name as database, database_scope as databaseScope, database_names as databaseNames, ssl, created_at as createdAt FROM database_connections ${where} ORDER BY name LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; const items = rows.map(row => { const databaseScope = row.databaseScope === 'all' ? 'all' : 'selected'; let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} if (databaseScope === 'selected' && !databases.length && row.database) databases = String(row.database).split(',').map(value => value.trim()).filter(Boolean); return { ...row, database: databaseScope === 'all' ? '*' : databases.join(', '), databaseScope, databases }; }); return this.pageResult(items, total, page, pageSize);
  }

  listJobsPage(input: any = {}) {
    const { page, pageSize, offset, search } = this.pageOptions(input); const where = search ? `WHERE LOWER(COALESCE(j.name,'') || ' ' || COALESCE(j.cron_expression,'') || ' ' || COALESCE(j.timezone,'') || ' ' || COALESCE(j.filename_prefix,'') || ' ' || COALESCE(c.name,'') || ' ' || COALESCE(s.name,'')) LIKE ?` : ''; const params = search ? [`%${search}%`] : []; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_jobs j LEFT JOIN database_connections c ON c.id=j.database_connection_id LEFT JOIN storage_targets s ON s.id=j.storage_target_id ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT j.id,j.name,j.database_connection_id as databaseConnectionId,j.storage_target_id as storageTargetId,j.database_scope as databaseScope,j.database_names as databaseNames,j.cron_expression as cronExpression,j.timezone,j.enabled,j.compression,j.backup_encryption as backupEncryption,j.retention_count as retentionCount,j.filename_prefix as filenamePrefix,j.next_run_at as nextRunAt,j.last_run_at as lastRunAt,j.created_at as createdAt FROM backup_jobs j LEFT JOIN database_connections c ON c.id=j.database_connection_id LEFT JOIN storage_targets s ON s.id=j.storage_target_id ${where} ORDER BY j.name LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; const items = rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} return { ...row, databaseScope: row.databaseScope === 'all' ? 'all' : 'selected', databases }; }); const activeTotal = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_jobs j LEFT JOIN database_connections c ON c.id=j.database_connection_id LEFT JOIN storage_targets s ON s.id=j.storage_target_id ${where} ${where ? 'AND' : 'WHERE'} j.enabled=1`).get(...params) as any)?.count || 0); return this.pageResult(items, total, page, pageSize, { activeTotal });
  }

  runsPage(input: any = {}) {
    const { page, pageSize, offset, search } = this.pageOptions(input); const status = ['success', 'failed', 'running'].includes(String(input.status)) ? String(input.status) : ''; const conditions: string[] = []; const params: any[] = []; if (status) { conditions.push('r.status=?'); params.push(status); } if (search) { conditions.push(`LOWER(COALESCE(j.name,'') || ' ' || COALESCE(r.filename,'') || ' ' || COALESCE(r.error_message,'')) LIKE ?`); params.push(`%${search}%`); } const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT r.id,r.job_id as jobId,j.name as jobName,j.database_connection_id as databaseConnectionId,j.database_scope as databaseScope,j.database_names as databaseNames,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.storage_location as storageLocation,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id ${where} ORDER BY r.started_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; const items = rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} return { ...row, databases }; }); const stats = this.store.db.prepare(`SELECT SUM(CASE WHEN r.status='success' THEN 1 ELSE 0 END) as successTotal,SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END) as failedTotal FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id ${where}`).get(...params) as any; return this.pageResult(items, total, page, pageSize, { successTotal: Number(stats?.successTotal || 0), failedTotal: Number(stats?.failedTotal || 0) });
  }

  runsForJobPage(jobId: string, input: any = {}) { const { page, pageSize, offset, search } = this.pageOptions(input); const where = search ? `AND LOWER(COALESCE(r.filename,'') || ' ' || COALESCE(r.error_message,'') || ' ' || COALESCE(r.status,'')) LIKE ?` : ''; const params = search ? [jobId, `%${search}%`] : [jobId]; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_runs r WHERE r.job_id=? ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT r.id,r.job_id as jobId,j.name as jobName,j.database_connection_id as databaseConnectionId,j.database_scope as databaseScope,j.database_names as databaseNames,s.name as storageTargetName,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.storage_location as storageLocation,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id JOIN storage_targets s ON s.id=j.storage_target_id WHERE r.job_id=? ${where} ORDER BY r.started_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; return this.pageResult(rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} return { ...row, databases }; }), total, page, pageSize); }

  liveProcesses() {
    const expiry = Date.now() - 15 * 60 * 1000;
    for (const [id, process] of this.liveProcessState) if (process.status !== 'running' && Date.parse(process.updatedAt) < expiry) this.liveProcessState.delete(id);
    const items = [...this.liveProcessState.values()].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return { items, updatedAt: this.store.now() };
  }

  listConnections() {
    const rows = this.store.db.prepare('SELECT id, name, engine, host, port, username, database_name as database, database_scope as databaseScope, database_names as databaseNames, ssl, created_at as createdAt FROM database_connections ORDER BY name').all() as any[];
    return rows.map(row => {
      const databaseScope = row.databaseScope === 'all' ? 'all' : 'selected';
      let databases: string[] = [];
      try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {}
      if (databaseScope === 'selected' && !databases.length && row.database) databases = String(row.database).split(',').map(value => value.trim()).filter(Boolean);
      return { ...row, database: databaseScope === 'all' ? '*' : databases.join(', '), databaseScope, databases };
    });
  }
  dependencyStatus() {
    const engines = ['mysql', 'mariadb'].map(engine => {
      const client = this.resolveClientBinary(engine, false);
      const dump = this.resolveClientBinary(engine, true);
      return { engine, client: { available: this.executableAvailable(client), command: path.basename(client) }, dump: { available: this.executableAvailable(dump), command: path.basename(dump) } };
    });
    return { ok: engines.some(item => item.client.available && item.dump.available), engines };
  }
  async dependencyDiagnostics() {
    const engines = await Promise.all(['mysql', 'mariadb'].map(async engine => {
      const client = this.resolveClientBinary(engine, false);
      const dump = this.resolveClientBinary(engine, true);
      const clientStatus = await this.probeDependency(client);
      const dumpStatus = await this.probeDependency(dump);
      const statuses = [clientStatus.status, dumpStatus.status];
      const status = statuses.includes('corrupt') ? 'corrupt' : statuses.includes('missing') ? 'missing' : 'working';
      return { engine, status, client: { ...clientStatus, command: path.basename(client) }, dump: { ...dumpStatus, command: path.basename(dump) } };
    }));
    return { ok: engines.some(item => item.status === 'working'), engines, checkedAt: this.store.now() };
  }
  saveConnection(body: any) {
    if (!body.name || !body.host || !body.username) throw new BadRequestException('Name, host and username are required');
    const id = body.id || crypto.randomUUID(); const old = this.store.db.prepare('SELECT password_enc,database_name FROM database_connections WHERE id = ?').get(id) as any;
    const hasNewPassword = typeof body.password === 'string' && body.password.length > 0;
    const passwordEnc = hasNewPassword ? this.store.encrypt(body.password) : (old?.password_enc || this.store.encrypt(''));
    const legacyDatabase = body.database || old?.database_name || '';
    this.store.db.prepare(`INSERT INTO database_connections (id,name,engine,host,port,username,password_enc,database_name,database_scope,database_names,ssl,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,engine=excluded.engine,host=excluded.host,port=excluded.port,username=excluded.username,password_enc=excluded.password_enc,database_name=excluded.database_name,ssl=excluded.ssl`).run(id, body.name, body.engine || 'mysql', body.host, Number(body.port || 3306), body.username, passwordEnc, legacyDatabase, 'selected', '[]', body.ssl ? 1 : 0, this.store.now());
    return this.listConnections().find(x => x.id === id);
  }
  async testConnection(body: any) {
    if (!body.host || !body.username) throw new BadRequestException('Host and username are required');
    if (body.host === '0.0.0.0' || body.host === '::') throw new BadRequestException('Use 127.0.0.1 or the actual database server address. 0.0.0.0 is only a server bind address.');
    let password = typeof body.password === 'string' ? body.password : '';
    if (!password && body.id) {
      const old = this.store.db.prepare('SELECT password_enc FROM database_connections WHERE id = ?').get(body.id) as any;
      if (old?.password_enc) password = this.store.decrypt(old.password_enc);
    }
    try {
      await this.withNativeDatabaseConnection({ host: body.host, port: Number(body.port || 3306), username: body.username, password, ssl: Boolean(body.ssl) }, connection => connection.query('SELECT 1'));
      return { ok: true, message: 'Database connection successful' };
    } catch (error: any) {
      return { ok: false, message: this.nativeClientMessage(error) };
    }
  }
  deleteConnection(id: string) { this.store.db.prepare('DELETE FROM database_connections WHERE id = ?').run(id); return { ok: true }; }
  async listAvailableDatabases(id: string) {
    const connection = this.getConnection(id);
    try {
      const [rows] = await this.withNativeDatabaseConnection<any>(connection, client => client.query('SHOW DATABASES'));
      const databases = (rows as any[]).map(row => String(row.Database || Object.values(row)[0] || '').trim()).filter(Boolean);
      return { databases: [...new Set(databases)] };
    } catch (error: any) {
      throw new BadRequestException(this.nativeClientMessage(error));
    }
  }
   listJobs() { const rows = this.store.db.prepare('SELECT id,name,database_connection_id as databaseConnectionId,storage_target_id as storageTargetId,database_scope as databaseScope,database_names as databaseNames,cron_expression as cronExpression,timezone,enabled,compression,backup_encryption as backupEncryption,retention_count as retentionCount,filename_prefix as filenamePrefix,next_run_at as nextRunAt,last_run_at as lastRunAt,created_at as createdAt FROM backup_jobs ORDER BY name').all() as any[]; return rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} return { ...row, databaseScope: row.databaseScope === 'all' ? 'all' : 'selected', databases }; }); }
   saveJob(body: any) { if (!body.name || !body.databaseConnectionId || !body.storageTargetId || !body.cronExpression) throw new BadRequestException('Name, database, storage, and schedule are required'); const databaseScope = body.databaseScope === 'all' ? 'all' : 'selected'; const rawDatabases = Array.isArray(body.databases) ? body.databases : String(body.databases ?? '').split(/[\n,]/); const databases = [...new Set(rawDatabases.map((value: unknown) => String(value).trim()).filter(Boolean))]; if (databaseScope === 'selected' && !databases.length) throw new BadRequestException('Select at least one database'); const timezone = body.timezone || 'UTC'; nextCron(body.cronExpression, new Date(), timezone); const id = body.id || crypto.randomUUID(); const prefix = safeFilePart(body.filenamePrefix || body.name); const next = nextCron(body.cronExpression, new Date(), timezone).toISOString(); const encryption = body.backupEncryption === 'aes-256-gcm' ? 'aes-256-gcm' : 'none'; this.store.db.prepare(`INSERT INTO backup_jobs (id,name,database_connection_id,storage_target_id,database_scope,database_names,cron_expression,timezone,enabled,compression,backup_encryption,retention_count,filename_prefix,next_run_at,last_run_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,database_connection_id=excluded.database_connection_id,storage_target_id=excluded.storage_target_id,database_scope=excluded.database_scope,database_names=excluded.database_names,cron_expression=excluded.cron_expression,timezone=excluded.timezone,enabled=excluded.enabled,compression=excluded.compression,backup_encryption=excluded.backup_encryption,retention_count=excluded.retention_count,filename_prefix=excluded.filename_prefix,next_run_at=excluded.next_run_at`).run(id, body.name, body.databaseConnectionId, body.storageTargetId, databaseScope, JSON.stringify(databases), body.cronExpression, timezone, body.enabled === false ? 0 : 1, body.compression === 'none' ? 'none' : 'gzip', encryption, Math.max(1, Math.min(365, Number(body.retentionCount || 7))), prefix, next, body.lastRunAt || null, this.store.now()); return this.listJobs().find((x: any) => x.id === id); }
  deleteJob(id: string) { this.store.db.prepare('DELETE FROM backup_jobs WHERE id = ?').run(id); return { ok: true }; }
   runs(filters: { status?: string; search?: string } = {}) { const where = filters.status && ['success','failed','running'].includes(filters.status) ? 'WHERE r.status=?' : ''; const params = where ? [filters.status] : []; const rows = this.store.db.prepare(`SELECT r.id,r.job_id as jobId,j.name as jobName,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id ${where} ORDER BY r.started_at DESC LIMIT 100`).all(...params); return filters.search ? rows.filter((row: any) => `${row.jobName} ${row.filename || ''}`.toLowerCase().includes(filters.search!.toLowerCase())) : rows; }
   runsForJob(jobId: string) { return this.store.db.prepare('SELECT r.id,r.job_id as jobId,j.name as jobName,s.name as storageTargetName,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id JOIN storage_targets s ON s.id=j.storage_target_id WHERE r.job_id=? ORDER BY r.started_at DESC LIMIT 100').all(jobId); }
  async runDue() { const jobs = this.store.db.prepare('SELECT * FROM backup_jobs WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at').all(this.store.now()) as any[]; for (const job of jobs) { if (this.running.has(job.id)) continue; this.store.db.prepare('UPDATE backup_jobs SET next_run_at=? WHERE id=?').run(nextCron(job.cron_expression, new Date(), job.timezone || 'UTC').toISOString(), job.id); void this.run(job.id).catch(error => this.logger.error(`Scheduled backup ${job.id} failed: ${error.message}`)); } }
  async runNow(id: string) { if (this.running.has(id)) throw new BadRequestException('This backup is already running'); return this.run(id); }
  async retryRun(runId: string) { const row = this.store.db.prepare('SELECT job_id as jobId FROM backup_runs WHERE id=?').get(runId) as any; if (!row?.jobId) throw new BadRequestException('Backup run not found'); return this.runNow(row.jobId); }

  private setProcessStage(id: string, stage: ProcessStage, status: LiveBackupProcess['status'] = 'running', message = '') {
    const process = this.liveProcessState.get(id); if (!process) return;
    process.stage = stage; process.status = status; process.updatedAt = this.store.now(); if (status !== 'running') process.finishedAt = process.updatedAt; if (message) this.addProcessLog(id, message);
  }
  private addProcessLog(id: string, message: string) {
    const process = this.liveProcessState.get(id); if (!process) return;
    const lines = String(message).replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean).slice(-20);
    for (const line of lines) process.logs.push(`[${new Date().toLocaleTimeString()}] ${line.slice(0, 1000)}`);
    process.logs = process.logs.slice(-100); process.updatedAt = this.store.now();
  }

  async downloadRun(runId: string) {
    this.store.assertEncryptionHealthy();
    const row = this.store.db.prepare('SELECT r.id,r.status,r.filename,r.storage_location as storageLocation,j.storage_target_id as storageTargetId FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id WHERE r.id=?').get(runId) as any;
    if (!row) throw new BadRequestException('Backup run not found');
    if (row.status !== 'success' || !row.filename) throw new BadRequestException('Only completed backups can be downloaded');
    const file = await this.storage.download(this.storage.get(String(row.storageTargetId)), String(row.filename), row.storageLocation ? String(row.storageLocation) : undefined);
    return { filename: String(row.filename), ...file };
  }

  async restoreRun(runId: string, input: any = {}) {
    this.store.assertEncryptionHealthy();
    const row = this.store.db.prepare('SELECT r.id,r.status,r.filename,r.storage_location as storageLocation,j.name as jobName,j.database_connection_id as sourceConnectionId,j.database_scope as databaseScope,j.database_names as databaseNames,j.storage_target_id as storageTargetId,j.compression,j.backup_encryption as backupEncryption FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id WHERE r.id=?').get(runId) as any;
    if (!row) throw new BadRequestException('Backup run not found');
    if (row.status !== 'success' || !row.filename) throw new BadRequestException('Only completed backups can be restored');
    const mode = input.mode === 'new' ? 'new' : 'overwrite';
    if (mode === 'overwrite' && input.overwriteConfirmed !== true) throw new BadRequestException('Confirm that the restore may overwrite existing data');
    const destination = this.getConnection(String(input.connectionId || ''));
    const source = this.getConnection(String(row.sourceConnectionId));
    let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} if (row.databaseScope === 'selected' && !databases.length) databases = source.databases;
    let newDatabase = '';
    if (mode === 'new') {
      if (row.databaseScope !== 'selected' || databases.length !== 1) throw new BadRequestException('Restore as a new name is available only for a backup containing one database');
      newDatabase = this.safeDatabaseName(input.databaseName);
      const available = await this.listAvailableDatabases(destination.id);
      if (available.databases.includes(newDatabase) && input.overwriteConfirmed !== true) throw new BadRequestException(`Database ${newDatabase} already exists. Confirm overwrite or choose another name.`);
    }
    const tempDir = fs.mkdtempSync(path.join(this.store.dataDir, 'tmp', 'restore-')); let downloaded: { path: string; cleanup: boolean } | undefined;
    try {
      const target = this.storage.get(String(row.storageTargetId)); downloaded = await this.storage.download(target, String(row.filename), row.storageLocation ? String(row.storageLocation) : undefined); let sqlFile = downloaded.path;
      const encrypted = row.backupEncryption === 'aes-256-gcm' || String(row.filename).endsWith('.enc'); const compressed = row.compression === 'gzip' || String(row.filename).includes('.sql.gz');
      if (encrypted) { const decrypted = path.join(tempDir, 'restore.sql.gz'); await this.decryptFile(sqlFile, decrypted); sqlFile = decrypted; }
      if (compressed) { const expanded = path.join(tempDir, 'restore.sql'); await pipeline(fs.createReadStream(sqlFile), createGunzip(), fs.createWriteStream(expanded, { mode: 0o600 })); sqlFile = expanded; }
      if (mode === 'new') { const rewritten = path.join(tempDir, 'restore-renamed.sql'); this.rewriteDatabaseName(sqlFile, databases[0], newDatabase, rewritten); sqlFile = rewritten; await this.executeMysql(destination, `CREATE DATABASE IF NOT EXISTS ${this.quoteIdentifier(newDatabase)}`); }
      await this.restoreSql(destination, sqlFile, mode === 'new' ? newDatabase : undefined);
      void this.system.notify('backup_success', `VaultBack restore completed: ${row.jobName || runId} → ${destination.name}`);
      return { ok: true, mode, destination: destination.name, database: newDatabase || (databases.length ? databases.join(', ') : 'database names from backup') };
    } finally {
      if (downloaded?.cleanup) { try { fs.rmSync(downloaded.path, { force: true }); fs.rmSync(path.dirname(downloaded.path), { recursive: true, force: true }); } catch {} }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async run(jobId: string) {
    this.running.add(jobId); const runId = crypto.randomUUID(); const started = this.store.now(); this.store.db.prepare('INSERT INTO backup_runs (id,job_id,status,started_at) VALUES (?,?,?,?)').run(runId, jobId, 'running', started);
    const job = this.store.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(jobId) as any; const startedProcess = this.store.now(); this.liveProcessState.set(runId, { id: runId, jobId, jobName: String(job?.name || jobId), status: 'running', stage: 'preparing', startedAt: startedProcess, updatedAt: startedProcess, logs: [] }); this.addProcessLog(runId, `Backup started for ${job?.name || jobId}`); let tempDir = '';
    try {
      const connection = this.getConnection(job.database_connection_id); const databaseScope: 'all' | 'selected' = job.database_scope === 'all' ? 'all' : 'selected'; let databases: string[] = []; try { databases = JSON.parse(String(job.database_names || '[]')); } catch {} if (databaseScope === 'selected' && !databases.length) databases = connection.databases; if (databaseScope === 'selected' && !databases.length) throw new Error('No databases selected for this schedule'); const backupConnection: DatabaseConnection = { ...connection, databaseScope, databases, database: databaseScope === 'all' ? '*' : databases[0] || '' }; const target = this.storage.get(job.storage_target_id); tempDir = fs.mkdtempSync(path.join(this.store.dataDir, 'tmp', 'run-')); const databaseLabel = backupConnection.databaseScope === 'all' ? 'all-databases' : backupConnection.databases.join('-'); const raw = path.join(tempDir, `${safeFilePart(databaseLabel || backupConnection.database)}-${Date.now()}.sql`); this.setProcessStage(runId, 'dumping'); this.addProcessLog(runId, `Dumping ${databaseScope === 'all' ? 'all visible databases' : `${databases.length} selected database(s)`}`); await this.dump(backupConnection, raw, runId); let artifact = raw; if (job.compression === 'gzip') { this.setProcessStage(runId, 'compressing'); this.addProcessLog(runId, 'Compressing SQL archive'); artifact = `${raw}.gz`; await pipeline(fs.createReadStream(raw), createGzip({ level: 6 }), fs.createWriteStream(artifact)); fs.rmSync(raw); }
      if (job.backup_encryption === 'aes-256-gcm') { this.setProcessStage(runId, 'encrypting'); this.addProcessLog(runId, 'Encrypting backup archive'); const encrypted = `${artifact}.enc`; await this.encryptFile(artifact, encrypted); fs.rmSync(artifact); artifact = encrypted; }
      this.setProcessStage(runId, 'verifying'); this.addProcessLog(runId, 'Verifying archive contents');
      const filename = `${safeFilePart(job.filename_prefix)}-${new Date().toISOString().replace(/[:.]/g, '-')}.${job.compression === 'gzip' ? 'sql.gz' : 'sql'}${job.backup_encryption === 'aes-256-gcm' ? '.enc' : ''}`;
      const verification = await this.verifyArtifact(artifact, job.compression === 'gzip', job.backup_encryption === 'aes-256-gcm', tempDir);
      const stats = fs.statSync(artifact); const hash = await this.sha256(artifact);
      this.setProcessStage(runId, 'uploading'); this.addProcessLog(runId, `Uploading ${filename}`);
      const uploaded = await this.storage.upload(target, artifact, filename);
      this.setProcessStage(runId, 'rotating'); this.addProcessLog(runId, 'Applying retention rotation');
      await this.storage.rotate(target, safeFilePart(job.filename_prefix), Number(job.retention_count));
      const finished = this.store.now(); this.store.db.prepare('UPDATE backup_runs SET status=?,finished_at=?,filename=?,storage_location=?,size_bytes=?,sha256=?,verification_status=?,verification_message=? WHERE id=?').run('success', finished, filename, uploaded.location, stats.size, hash, verification.status, verification.message, runId); this.store.db.prepare('UPDATE backup_jobs SET last_run_at=? WHERE id=?').run(finished, jobId); void this.system.notify('backup_success', `VaultBack backup succeeded: ${job.name || jobId} -> ${filename}`); return { ok: true, filename, sizeBytes: stats.size, sha256: hash, verification };
    } catch (error: any) { const message = String(error.message || error).slice(0, 1000); this.logger.error(`Backup ${jobId} failed: ${message}`); this.setProcessStage(runId, 'failed', 'failed', message); this.store.db.prepare('UPDATE backup_runs SET status=?,finished_at=?,error_message=?,verification_status=? WHERE id=?').run('failed', this.store.now(), message, 'failed', runId); void this.system.notify('backup_failed', `VaultBack backup failed: ${jobId}\n${message}`); throw error; } finally { const process = this.liveProcessState.get(runId); if (process?.status === 'running') this.setProcessStage(runId, 'completed', 'success', 'Backup process finished'); this.running.delete(jobId); if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); }
  }
  private async encryptFile(input: string, output: string) {
    const iv = crypto.randomBytes(12); const out = fs.createWriteStream(output, { mode: 0o600 }); out.write(Buffer.from('VBENC1')); out.write(iv);
    const cipher = createCipheriv('aes-256-gcm', this.store.deriveKey('backup-file-v1'), iv);
    await pipeline(fs.createReadStream(input), cipher, out); fs.appendFileSync(output, cipher.getAuthTag());
  }

  private async decryptFile(input: string, output: string) {
    const size = fs.statSync(input).size; if (size < 34) throw new Error('Encrypted backup is too short');
    const fd = fs.openSync(input, 'r'); const header = Buffer.alloc(18); fs.readSync(fd, header, 0, 18, 0); const tag = Buffer.alloc(16); fs.readSync(fd, tag, 0, 16, size - 16); fs.closeSync(fd);
    if (header.subarray(0, 6).toString() !== 'VBENC1') throw new Error('Encrypted backup header is invalid');
    const decipher = createDecipheriv('aes-256-gcm', this.store.deriveKey('backup-file-v1'), header.subarray(6, 18)); decipher.setAuthTag(tag);
    await pipeline(fs.createReadStream(input, { start: 18, end: size - 17 }), decipher, fs.createWriteStream(output, { mode: 0o600 }));
  }

  private async verifyArtifact(file: string, compressed: boolean, encrypted: boolean, tempDir: string) {
    let source = file; let intermediate = '';
    try {
      if (encrypted) { intermediate = path.join(tempDir, 'verified-artifact'); await this.decryptFile(source, intermediate); source = intermediate; }
      if (compressed) { const sqlFile = path.join(tempDir, 'verified.sql'); await pipeline(fs.createReadStream(source), createGunzip(), fs.createWriteStream(sqlFile, { mode: 0o600 })); source = sqlFile; }
      const preview = this.readPrefix(source, 32768);
      if (!preview.trim()) throw new Error('Backup archive is empty');
      if (!/CREATE\s+(DATABASE|TABLE)|INSERT\s+INTO|--\s*(MySQL|MariaDB) dump|SET\s+\@/i.test(preview)) throw new Error('Backup archive does not contain recognizable SQL dump content');
      return { status: 'passed', message: encrypted ? 'Encrypted archive opened and SQL content verified' : 'Archive opened and SQL content verified' };
    } finally { if (intermediate && fs.existsSync(intermediate)) fs.rmSync(intermediate, { force: true }); }
  }

  private readPrefix(file: string, length: number) {
    const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(length); let bytes = 0;
    try { bytes = fs.readSync(fd, buffer, 0, length, 0); } finally { fs.closeSync(fd); }
    return buffer.subarray(0, bytes).toString('utf8');
  }

  private getConnection(id: string): DatabaseConnection { this.store.assertEncryptionHealthy(); const row = this.store.db.prepare('SELECT * FROM database_connections WHERE id=?').get(id) as any; if (!row) throw new Error('Database connection not found'); const databaseScope = row.database_scope === 'all' ? 'all' : 'selected'; let databases: string[] = []; try { databases = JSON.parse(String(row.database_names || '[]')); } catch {} if (databaseScope === 'selected' && !databases.length && row.database_name) databases = String(row.database_name).split(',').map(value => value.trim()).filter(Boolean); return { id: row.id, name: row.name, engine: row.engine, host: row.host, port: row.port, username: row.username, password: this.store.decrypt(row.password_enc), database: databaseScope === 'all' ? '*' : databases[0], databaseScope, databases, ssl: Boolean(row.ssl), createdAt: row.created_at }; }
  private safeDatabaseName(value: unknown) { const name = String(value || '').trim(); if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new BadRequestException('New database name may contain only letters, numbers, and underscores'); return name; }
  private quoteIdentifier(value: string) { return `\`${value.replace(/`/g, '``')}\``; }
  private rewriteDatabaseName(input: string, source: string, target: string, output: string) { const sourceQuoted = this.quoteIdentifier(source); const targetQuoted = this.quoteIdentifier(target); const content = fs.readFileSync(input, 'utf8').split(/\r?\n/).map(line => /^(\s*)(CREATE\s+DATABASE|USE)\b/i.test(line) ? line.split(sourceQuoted).join(targetQuoted) : line).join('\n'); fs.writeFileSync(output, content, { encoding: 'utf8', mode: 0o600 }); }
  private executeMysql(connection: DatabaseConnection, statement: string) { return this.spawnMysql(connection, [`--execute=${statement}`]); }
  private restoreSql(connection: DatabaseConnection, sqlFile: string, database?: string) { return this.spawnMysql(connection, database ? [`--database=${database}`] : [], sqlFile); }
  private spawnMysql(connection: DatabaseConnection, extraArgs: string[], inputFile?: string) { return new Promise<void>((resolve, reject) => { const binary = this.resolveClientBinary(connection.engine, false); const args = ['--no-defaults', `--host=${connection.host}`, `--port=${connection.port}`, `--user=${connection.username}`, '--connect-timeout=10', ...extraArgs]; if (connection.ssl) args.push('--ssl'); const env = { ...process.env }; if (connection.password) env.MYSQL_PWD = connection.password; else delete env.MYSQL_PWD; let child: ReturnType<typeof spawn>; try { child = spawn(binary, args, { env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }); } catch (error: any) { return reject(new BadRequestException(this.clientStartMessage(binary, error))); } let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk.toString(); }); const input = inputFile ? fs.createReadStream(inputFile) : undefined; const stdin = child.stdin; if (input) { if (!stdin) return reject(new BadRequestException('Unable to open database restore input')); input.pipe(stdin); } else stdin?.end(); input?.on('error', error => { child.kill(); reject(error); }); child.on('error', error => reject(new BadRequestException(this.clientStartMessage(binary, error)))); child.on('close', code => code === 0 ? resolve() : reject(new BadRequestException(`${binary} restore failed with code ${code}: ${stderr.slice(0, 1000)}`))); }); }
  private async withNativeDatabaseConnection<T>(connection: { host: string; port: number; username: string; password: string; ssl: boolean }, action: (client: any) => Promise<T>): Promise<T> {
    let client: any;
    try {
      client = await createConnection({ host: connection.host, port: connection.port, user: connection.username, password: connection.password, ssl: connection.ssl ? {} : undefined, connectTimeout: 10000, multipleStatements: false });
      return await action(client);
    } finally {
      if (client) await client.end().catch(() => undefined);
    }
  }
  private nativeClientMessage(error: any) {
    const code = String(error?.code || '').trim();
    const detail = String(error?.message || error || 'Unknown database connection error').replace(/\s+/g, ' ').slice(0, 500);
    return `Database connection failed${code ? ` (${code})` : ''}: ${detail}`;
  }
  private resolveClientBinary(engine: string, dump: boolean): string {
    const engineFolder = engine === 'mariadb' ? 'mariadb' : 'mysql';
    const executable = dump ? (engine === 'mariadb' ? 'mariadb-dump' : 'mysqldump') : (engine === 'mariadb' ? 'mariadb' : 'mysql');
    const alternate = dump ? (engine === 'mariadb' ? 'mysqldump' : 'mariadb-dump') : (engine === 'mariadb' ? 'mysql' : 'mariadb');
    const binaryNames = process.platform === 'win32' ? [`${executable}.exe`, `${alternate}.exe`, executable, alternate] : [executable, alternate];
    const platformFolder = `${process.platform}-${process.arch}`;
    const toolsRoot = path.join(process.cwd(), 'tools');
    const portableRoots = [
      path.join(toolsRoot, engineFolder, platformFolder, 'bin'),
      path.join(toolsRoot, engineFolder, 'bin'),
      // The automatic setup installs one MariaDB community client pack. Its
      // client protocol and dump format are compatible with both engines, so
      // use it as a local fallback for MySQL connections.
      ...(engine === 'mysql' ? [path.join(toolsRoot, 'mariadb', platformFolder, 'bin'), path.join(toolsRoot, 'mariadb', 'bin')] : [])
    ];
    for (const root of portableRoots) for (const name of binaryNames) { const candidate = path.join(root, name); if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; }
    return path.join(toolsRoot, engineFolder, platformFolder, 'bin', process.platform === 'win32' ? `${executable}.exe` : executable);
  }
  private executableAvailable(binary: string) {
    try { return fs.existsSync(binary) && fs.statSync(binary).isFile(); } catch { return false; }
  }
  private probeDependency(binary: string): Promise<{ available: boolean; status: 'working' | 'missing' | 'corrupt' }> {
    if (!this.executableAvailable(binary)) return Promise.resolve({ available: false, status: 'missing' });
    return new Promise(resolve => {
      let settled = false;
      let child: ReturnType<typeof spawn>;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (status: 'working' | 'corrupt') => { if (settled) return; settled = true; clearTimeout(timer); resolve({ available: true, status }); };
      timer = setTimeout(() => { try { child.kill(); } catch {} finish('corrupt'); }, 5000);
      timer.unref?.();
      try { child = spawn(binary, ['--no-defaults', '--version'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }); }
      catch { finish('corrupt'); return; }
      child.once('error', () => finish('corrupt'));
      child.once('close', code => finish(code === 0 ? 'working' : 'corrupt'));
    });
  }
  private clientStartMessage(binary: string, error: any) {
    if (error?.code === 'EPERM') return `Windows blocked VaultBack from launching ${path.basename(binary)}. Confirm the bundled tool is executable and run VaultBack under a Windows/PM2 account allowed to start child processes.`;
    if (error?.code === 'ENOENT') return `Bundled database tool not found: ${binary}. Open Settings and use Repair and redownload tools.`;
    return `Could not start ${binary}: ${error?.message || error}`;
  }
  private dump(connection: DatabaseConnection, output: string, processId?: string) { return new Promise<void>((resolve, reject) => { const binary = this.resolveClientBinary(connection.engine, true); const args = ['--no-defaults', `--host=${connection.host}`, `--port=${connection.port}`, `--user=${connection.username}`, '--single-transaction', '--routines', '--events', '--triggers', '--hex-blob']; if (connection.databaseScope === 'all') args.push('--all-databases'); else args.push('--databases', ...connection.databases); const child = spawn(binary, args, { env: { ...process.env, MYSQL_PWD: connection.password }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); const out = fs.createWriteStream(output, { mode: 0o600 }); let stderr = ''; child.stdout.pipe(out); child.stderr.on('data', chunk => { const text = chunk.toString(); stderr += text; if (processId) this.addProcessLog(processId, text); }); child.on('error', error => { out.close(); if (processId) this.addProcessLog(processId, this.clientStartMessage(binary, error)); reject(new Error(this.clientStartMessage(binary, error))); }); child.on('close', code => { out.close(); if (code === 0) resolve(); else reject(new Error(`${binary} failed with code ${code}: ${stderr.slice(0, 800)}`)); }); }); }
  private async sha256(file: string) { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
}
