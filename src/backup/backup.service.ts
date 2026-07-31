import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';
import { DatabaseService } from '../database/database.service';
import { BackupJob, BackupObjectOptions, DatabaseConnection, StorageTarget } from '../types';
import { ensureDirectory, nextCron, safeFilePart } from './backup.utils';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createDeflateRaw, createGzip, createGunzip, createInflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createDecipheriv, createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { SystemService } from '../system/system.service';
import { createConnection } from 'mysql2/promise';
import { RealtimeService } from '../system/realtime.service';

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
type ZipEntry = { name: string; method: number; compressedSize: number; uncompressedSize: number; localOffset: number };
const ZIP_CRC_TABLE = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1; return value >>> 0; });

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private readonly running = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly liveProcessState = new Map<string, LiveBackupProcess>();
  constructor(private readonly store: DatabaseService, private readonly storage: StorageService, private readonly system: SystemService, private readonly realtime: RealtimeService) {}

  private pageOptions(input: any = {}) { const page = Math.max(1, Number.parseInt(String(input.page || '1'), 10) || 1); const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(input.pageSize || '25'), 10) || 25)); return { page, pageSize, offset: (page - 1) * pageSize, search: String(input.search || '').trim().toLowerCase() }; }
  private pageResult(items: any[], total: number, page: number, pageSize: number, extra: Record<string, unknown> = {}) { return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), ...extra }; }
  private backupObjects(value: unknown, layout: string = 'single'): BackupObjectOptions {
    let parsed: any = {};
    try { parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value || {}; } catch {}
    const splitTableDefaults = layout === 'table';
    return {
      views: parsed.views === undefined ? !splitTableDefaults : Boolean(parsed.views),
      routines: parsed.routines === undefined ? !splitTableDefaults : Boolean(parsed.routines),
      triggers: parsed.triggers === undefined ? true : Boolean(parsed.triggers),
      events: parsed.events === undefined ? !splitTableDefaults : Boolean(parsed.events)
    };
  }

  listConnectionsPage(input: any = {}) {
    const { page, pageSize, offset, search } = this.pageOptions(input); const where = search ? `WHERE LOWER(COALESCE(name,'') || ' ' || COALESCE(engine,'') || ' ' || COALESCE(host,'') || ' ' || COALESCE(username,'') || ' ' || COALESCE(database_name,'')) LIKE ?` : ''; const params = search ? [`%${search}%`] : []; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM database_connections ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT id, name, engine, host, port, username, database_name as database, database_scope as databaseScope, database_names as databaseNames, ssl, created_at as createdAt FROM database_connections ${where} ORDER BY name LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; const items = rows.map(row => { const databaseScope = row.databaseScope === 'all' ? 'all' : 'selected'; let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} if (databaseScope === 'selected' && !databases.length && row.database) databases = String(row.database).split(',').map(value => value.trim()).filter(Boolean); return { ...row, database: databaseScope === 'all' ? '*' : databases.join(', '), databaseScope, databases }; }); return this.pageResult(items, total, page, pageSize);
  }

  listJobsPage(input: any = {}) {
    const { page, pageSize, offset, search } = this.pageOptions(input); const where = search ? `WHERE LOWER(COALESCE(j.name,'') || ' ' || COALESCE(j.cron_expression,'') || ' ' || COALESCE(j.timezone,'') || ' ' || COALESCE(j.filename_prefix,'') || ' ' || COALESCE(c.name,'') || ' ' || COALESCE(s.name,'')) LIKE ?` : ''; const params = search ? [`%${search}%`] : []; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_jobs j LEFT JOIN database_connections c ON c.id=j.database_connection_id LEFT JOIN storage_targets s ON s.id=j.storage_target_id ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT j.id,j.name,j.database_connection_id as databaseConnectionId,j.storage_target_id as storageTargetId,j.database_scope as databaseScope,j.database_names as databaseNames,j.backup_layout as backupLayout,j.backup_objects as backupObjects,j.cron_expression as cronExpression,j.timezone,j.enabled,j.compression,j.backup_encryption as backupEncryption,j.retention_count as retentionCount,j.retry_count as retryCount,j.retry_delay_seconds as retryDelaySeconds,j.overlap_policy as overlapPolicy,j.filename_prefix as filenamePrefix,j.next_run_at as nextRunAt,j.last_run_at as lastRunAt,j.created_at as createdAt FROM backup_jobs j LEFT JOIN database_connections c ON c.id=j.database_connection_id LEFT JOIN storage_targets s ON s.id=j.storage_target_id ${where} ORDER BY j.name LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; const items = rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} const backupLayout = ['database', 'table'].includes(row.backupLayout) ? row.backupLayout : 'single'; return { ...row, databaseScope: row.databaseScope === 'all' ? 'all' : 'selected', backupLayout, backupObjects: this.backupObjects(row.backupObjects, backupLayout), databases }; }); const activeTotal = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_jobs j LEFT JOIN database_connections c ON c.id=j.database_connection_id LEFT JOIN storage_targets s ON s.id=j.storage_target_id ${where} ${where ? 'AND' : 'WHERE'} j.enabled=1`).get(...params) as any)?.count || 0); return this.pageResult(items, total, page, pageSize, { activeTotal });
  }

  runsPage(input: any = {}) {
    const { page, pageSize, offset, search } = this.pageOptions(input); const status = ['success', 'failed', 'running'].includes(String(input.status)) ? String(input.status) : ''; const conditions: string[] = []; const params: any[] = []; if (status) { conditions.push('r.status=?'); params.push(status); } if (search) { conditions.push(`LOWER(COALESCE(j.name,'') || ' ' || COALESCE(r.filename,'') || ' ' || COALESCE(r.error_message,'')) LIKE ?`); params.push(`%${search}%`); } const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT r.id,r.job_id as jobId,j.name as jobName,j.database_connection_id as databaseConnectionId,j.database_scope as databaseScope,j.database_names as databaseNames,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.storage_location as storageLocation,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id ${where} ORDER BY r.started_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; const items = rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} return { ...row, databases }; }); const stats = this.store.db.prepare(`SELECT SUM(CASE WHEN r.status='success' THEN 1 ELSE 0 END) as successTotal,SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END) as failedTotal FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id ${where}`).get(...params) as any; return this.pageResult(items, total, page, pageSize, { successTotal: Number(stats?.successTotal || 0), failedTotal: Number(stats?.failedTotal || 0) });
  }

  runsForJobPage(jobId: string, input: any = {}) { const { page, pageSize, offset, search } = this.pageOptions(input); const where = search ? `AND LOWER(COALESCE(r.filename,'')) LIKE ?` : ''; const params = search ? [jobId, `%${search}%`] : [jobId]; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_runs r WHERE r.job_id=? AND r.status='success' AND r.filename IS NOT NULL AND TRIM(r.filename) <> '' ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT r.id,r.job_id as jobId,j.name as jobName,j.database_connection_id as databaseConnectionId,j.database_scope as databaseScope,j.database_names as databaseNames,s.name as storageTargetName,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.storage_location as storageLocation,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id JOIN storage_targets s ON s.id=j.storage_target_id WHERE r.job_id=? AND r.status='success' AND r.filename IS NOT NULL AND TRIM(r.filename) <> '' ${where} ORDER BY r.started_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; return this.pageResult(rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} return { ...row, databases }; }), total, page, pageSize); }

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
   listJobs() { const rows = this.store.db.prepare('SELECT id,name,database_connection_id as databaseConnectionId,storage_target_id as storageTargetId,database_scope as databaseScope,database_names as databaseNames,backup_layout as backupLayout,backup_objects as backupObjects,cron_expression as cronExpression,timezone,enabled,compression,backup_encryption as backupEncryption,retention_count as retentionCount,retry_count as retryCount,retry_delay_seconds as retryDelaySeconds,overlap_policy as overlapPolicy,filename_prefix as filenamePrefix,next_run_at as nextRunAt,last_run_at as lastRunAt,created_at as createdAt FROM backup_jobs ORDER BY name').all() as any[]; return rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} const backupLayout = ['database', 'table'].includes(row.backupLayout) ? row.backupLayout : 'single'; return { ...row, databaseScope: row.databaseScope === 'all' ? 'all' : 'selected', backupLayout, backupObjects: this.backupObjects(row.backupObjects, backupLayout), databases }; }); }
   saveJob(body: any) { if (!body.name || !body.databaseConnectionId || !body.storageTargetId || !body.cronExpression) throw new BadRequestException('Name, database, storage, and schedule are required'); const databaseScope = body.databaseScope === 'all' ? 'all' : 'selected'; const rawDatabases = Array.isArray(body.databases) ? body.databases : String(body.databases ?? '').split(/[\n,]/); const databases = [...new Set(rawDatabases.map((value: unknown) => String(value).trim()).filter(Boolean))]; if (databaseScope === 'selected' && !databases.length) throw new BadRequestException('Select at least one database'); const backupLayout = ['database', 'table'].includes(body.backupLayout) ? body.backupLayout : 'single'; const backupObjects = this.backupObjects(body.backupObjects, backupLayout); const timezone = body.timezone || 'UTC'; nextCron(body.cronExpression, new Date(), timezone); const id = body.id || crypto.randomUUID(); const prefix = safeFilePart(body.filenamePrefix || body.name); const next = nextCron(body.cronExpression, new Date(), timezone).toISOString(); const encryption = body.backupEncryption === 'aes-256-gcm' ? 'aes-256-gcm' : 'none'; const requestedCompression = ['none', 'gzip', 'zip'].includes(body.compression) ? body.compression : 'gzip'; const compression = backupLayout === 'single' ? requestedCompression : 'zip'; const retryCount = Math.max(0, Math.min(10, Number(body.retryCount || 0))); const retryDelaySeconds = Math.max(30, Math.min(86400, Number(body.retryDelaySeconds || 300))); const overlapPolicy = body.overlapPolicy === 'queue' ? 'queue' : 'skip'; this.store.db.prepare(`INSERT INTO backup_jobs (id,name,database_connection_id,storage_target_id,database_scope,database_names,backup_layout,backup_objects,cron_expression,timezone,enabled,compression,backup_encryption,retention_count,retry_count,retry_delay_seconds,overlap_policy,filename_prefix,next_run_at,last_run_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,database_connection_id=excluded.database_connection_id,storage_target_id=excluded.storage_target_id,database_scope=excluded.database_scope,database_names=excluded.database_names,backup_layout=excluded.backup_layout,backup_objects=excluded.backup_objects,cron_expression=excluded.cron_expression,timezone=excluded.timezone,enabled=excluded.enabled,compression=excluded.compression,backup_encryption=excluded.backup_encryption,retention_count=excluded.retention_count,retry_count=excluded.retry_count,retry_delay_seconds=excluded.retry_delay_seconds,overlap_policy=excluded.overlap_policy,filename_prefix=excluded.filename_prefix,next_run_at=excluded.next_run_at`).run(id, body.name, body.databaseConnectionId, body.storageTargetId, databaseScope, JSON.stringify(databases), backupLayout, JSON.stringify(backupObjects), body.cronExpression, timezone, body.enabled === false ? 0 : 1, compression, encryption, Math.max(1, Math.min(365, Number(body.retentionCount || 7))), retryCount, retryDelaySeconds, overlapPolicy, prefix, next, body.lastRunAt || null, this.store.now()); return this.listJobs().find((x: any) => x.id === id); }
  deleteJob(id: string) { this.store.db.prepare('DELETE FROM backup_jobs WHERE id = ?').run(id); return { ok: true }; }
   runs(filters: { status?: string; search?: string } = {}) { const where = filters.status && ['success','failed','running'].includes(filters.status) ? 'WHERE r.status=?' : ''; const params = where ? [filters.status] : []; const rows = this.store.db.prepare(`SELECT r.id,r.job_id as jobId,j.name as jobName,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id ${where} ORDER BY r.started_at DESC LIMIT 100`).all(...params); return filters.search ? rows.filter((row: any) => `${row.jobName} ${row.filename || ''}`.toLowerCase().includes(filters.search!.toLowerCase())) : rows; }
   runsForJob(jobId: string) { return this.store.db.prepare('SELECT r.id,r.job_id as jobId,j.name as jobName,s.name as storageTargetName,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id JOIN storage_targets s ON s.id=j.storage_target_id WHERE r.job_id=? ORDER BY r.started_at DESC LIMIT 100').all(jobId); }
   async runDue() { const jobs = this.store.db.prepare('SELECT * FROM backup_jobs WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at').all(this.store.now()) as any[]; for (const job of jobs) { if (this.running.has(job.id)) { if (job.overlap_policy === 'queue') { this.queued.add(job.id); this.logger.warn(`Backup ${job.id} is already running; overlap queued by schedule policy`); } else void this.system.notifyOnce('backup_failed', `overlap:${job.id}`, `VaultBack skipped overlapping backup: ${job.name || job.id}`); continue; } this.store.db.prepare('UPDATE backup_jobs SET next_run_at=? WHERE id=?').run(nextCron(job.cron_expression, new Date(), job.timezone || 'UTC').toISOString(), job.id); void this.run(job.id).catch(error => this.logger.error(`Scheduled backup ${job.id} failed: ${error.message}`)); } }
   async runNow(id: string) { if (this.running.has(id)) throw new BadRequestException('This backup is already running'); return this.run(id); }
   async monitorHealth() {
     const staleHours = Math.max(1, Number.parseInt(String(process.env.BACKUP_STALE_AFTER_HOURS || '26'), 10) || 26);
     const staleBefore = Date.now() - staleHours * 60 * 60 * 1000;
     const jobs = this.store.db.prepare('SELECT id,name FROM backup_jobs WHERE enabled=1').all() as any[];
     for (const job of jobs) { const latest = this.store.db.prepare(`SELECT finished_at as finishedAt FROM backup_runs WHERE job_id=? AND status='success' ORDER BY finished_at DESC LIMIT 1`).get(job.id) as any; if (!latest?.finishedAt || Date.parse(String(latest.finishedAt)) < staleBefore) void this.system.notifyOnce('backup_stale', String(job.id), `VaultBack backup is stale or has never succeeded: ${job.name || job.id}`); }
     for (const target of this.storage.list()) { try { await this.storage.health(this.storage.get(target.id)); } catch (error: any) { void this.system.notifyOnce('storage_failed', target.id, `VaultBack storage target unavailable: ${target.name}. ${String(error?.message || error).slice(0, 240)}`); } }
   }
  async retryRun(runId: string) { const row = this.store.db.prepare('SELECT job_id as jobId FROM backup_runs WHERE id=?').get(runId) as any; if (!row?.jobId) throw new BadRequestException('Backup run not found'); return this.runNow(row.jobId); }
  verificationReport(runId: string) { const items = this.store.db.prepare('SELECT id,run_id as runId,kind,status,message,details_json as detailsJson,created_at as createdAt FROM verification_reports WHERE run_id=? ORDER BY created_at DESC').all(runId) as any[]; return items.map(item => { let details: unknown = {}; try { details = JSON.parse(item.detailsJson || '{}'); } catch {} return { ...item, details }; }); }

  private setProcessStage(id: string, stage: ProcessStage, status: LiveBackupProcess['status'] = 'running', message = '') {
    const process = this.liveProcessState.get(id); if (!process) return;
    process.stage = stage; process.status = status; process.updatedAt = this.store.now(); if (status !== 'running') process.finishedAt = process.updatedAt; if (message) this.addProcessLog(id, message);
    this.realtime.publishThrottled('processes', this.liveProcesses(), 120);
    if (status !== 'running') this.realtime.publish('backup_runs', { runId: id, jobId: process.jobId, status, updatedAt: process.updatedAt });
  }
  private addProcessLog(id: string, message: string) {
    const process = this.liveProcessState.get(id); if (!process) return;
    const lines = String(message).replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean).slice(-20);
    for (const line of lines) process.logs.push(`[${new Date().toLocaleTimeString()}] ${line.slice(0, 1000)}`);
    process.logs = process.logs.slice(-100); process.updatedAt = this.store.now();
    this.realtime.publishThrottled('processes', this.liveProcesses(), 120);
  }

  async downloadRun(runId: string) {
    this.store.assertEncryptionHealthy();
    const row = this.store.db.prepare('SELECT r.id,r.status,r.filename,r.storage_location as storageLocation,r.storage_folder as storageFolder,j.storage_target_id as storageTargetId FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id WHERE r.id=?').get(runId) as any;
    if (!row) throw new BadRequestException('Backup run not found');
    if (row.status !== 'success' || !row.filename) throw new BadRequestException('Only completed backups can be downloaded');
    const file = await this.storage.download(this.storage.get(String(row.storageTargetId)), String(row.filename), row.storageLocation ? String(row.storageLocation) : undefined, row.storageFolder ? String(row.storageFolder) : '');
    return { filename: String(row.filename), ...file };
  }

  async restoreRun(runId: string, input: any = {}) {
    this.store.assertEncryptionHealthy();
    const row = this.store.db.prepare('SELECT r.id,r.status,r.filename,r.storage_location as storageLocation,r.storage_folder as storageFolder,j.name as jobName,j.database_connection_id as sourceConnectionId,j.database_scope as databaseScope,j.database_names as databaseNames,j.backup_layout as backupLayout,j.storage_target_id as storageTargetId,j.compression,j.backup_encryption as backupEncryption FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id WHERE r.id=?').get(runId) as any;
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
      const target = this.storage.get(String(row.storageTargetId)); downloaded = await this.storage.download(target, String(row.filename), row.storageLocation ? String(row.storageLocation) : undefined, row.storageFolder ? String(row.storageFolder) : ''); let sqlFile = downloaded.path; const backupLayout = ['database', 'table'].includes(row.backupLayout) ? row.backupLayout : 'single'; const compression: 'none' | 'gzip' | 'zip' = ['none', 'gzip', 'zip'].includes(row.compression) ? row.compression : String(row.filename).includes('.sql.gz') ? 'gzip' : String(row.filename).endsWith('.zip') || String(row.filename).endsWith('.zip.enc') ? 'zip' : 'none';
      const encrypted = row.backupEncryption === 'aes-256-gcm' || String(row.filename).endsWith('.enc');
      if (encrypted) { const decrypted = path.join(tempDir, compression === 'zip' ? 'restore.zip' : compression === 'gzip' ? 'restore.sql.gz' : 'restore.sql'); await this.decryptFile(sqlFile, decrypted); sqlFile = decrypted; }
      if (compression === 'gzip') { const expanded = path.join(tempDir, 'restore.sql'); await pipeline(fs.createReadStream(sqlFile), createGunzip(), fs.createWriteStream(expanded, { mode: 0o600 })); sqlFile = expanded; }
      if (compression === 'zip') { const entries = this.readZipEntries(sqlFile).filter(entry => entry.name.toLowerCase().endsWith('.sql')); if (!entries.length) throw new BadRequestException('ZIP backup does not contain SQL files'); if (mode === 'new') await this.executeMysql(destination, `CREATE DATABASE IF NOT EXISTS ${this.quoteIdentifier(newDatabase)}`); for (const [index, entry] of entries.entries()) { const extracted = path.join(tempDir, `restore-${index}.sql`); await this.extractZipEntry(sqlFile, entry, extracted); const sourceDatabase = entry.name.split('/')[0]; let restoreFile = extracted; if (mode === 'new' && backupLayout === 'database') { restoreFile = path.join(tempDir, `restore-renamed-${index}.sql`); this.rewriteDatabaseName(extracted, sourceDatabase, newDatabase, restoreFile); } const destinationDatabase = mode === 'new' ? newDatabase : backupLayout === 'table' ? sourceDatabase : undefined; await this.restoreSql(destination, restoreFile, destinationDatabase); } } else { if (mode === 'new') { const rewritten = path.join(tempDir, 'restore-renamed.sql'); this.rewriteDatabaseName(sqlFile, databases[0], newDatabase, rewritten); sqlFile = rewritten; await this.executeMysql(destination, `CREATE DATABASE IF NOT EXISTS ${this.quoteIdentifier(newDatabase)}`); } await this.restoreSql(destination, sqlFile, mode === 'new' ? newDatabase : undefined); }
      let restoreVerification: { status: string; message: string; details: unknown } = { status: 'skipped', message: 'Restore verification was disabled', details: {} };
      if (input.verifyAfterRestore !== false) {
        restoreVerification = await this.verifyRestore(destination, mode === 'new' ? [newDatabase] : databases);
        this.store.db.prepare('INSERT INTO verification_reports (id,run_id,kind,status,message,details_json,created_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(), runId, 'restore', restoreVerification.status, restoreVerification.message, JSON.stringify(restoreVerification.details), this.store.now());
        this.store.db.prepare('UPDATE backup_runs SET restore_verification_status=?,restore_verification_message=? WHERE id=?').run(restoreVerification.status, restoreVerification.message, runId);
        if (restoreVerification.status !== 'passed') throw new BadRequestException(`Restore completed but verification failed: ${restoreVerification.message}`);
      }
      void this.system.notify('backup_success', `VaultBack restore completed: ${row.jobName || runId} → ${destination.name}`);
      return { ok: true, mode, destination: destination.name, database: newDatabase || (databases.length ? databases.join(', ') : 'database names from backup'), verification: restoreVerification };
    } finally {
      if (downloaded?.cleanup) { try { fs.rmSync(downloaded.path, { force: true }); fs.rmSync(path.dirname(downloaded.path), { recursive: true, force: true }); } catch {} }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async run(jobId: string, attempt = 0) {
    this.running.add(jobId); const runId = crypto.randomUUID(); const started = this.store.now(); const previous = this.store.db.prepare("SELECT attempt FROM backup_runs WHERE job_id=? AND status='retrying' ORDER BY started_at DESC LIMIT 1").get(jobId) as any; const runAttempt = attempt || Number(previous?.attempt || 0) + 1; this.store.db.prepare('INSERT INTO backup_runs (id,job_id,status,started_at,attempt) VALUES (?,?,?,?,?)').run(runId, jobId, 'running', started, runAttempt);
    const job = this.store.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(jobId) as any; const startedProcess = this.store.now(); this.liveProcessState.set(runId, { id: runId, jobId, jobName: String(job?.name || jobId), status: 'running', stage: 'preparing', startedAt: startedProcess, updatedAt: startedProcess, logs: [] }); this.addProcessLog(runId, `Backup started for ${job?.name || jobId}`); let tempDir = '';
    try {
      const connection = this.getConnection(job.database_connection_id); const databaseScope: 'all' | 'selected' = job.database_scope === 'all' ? 'all' : 'selected'; const backupLayout = ['database', 'table'].includes(job.backup_layout) ? job.backup_layout : 'single'; const backupObjects = this.backupObjects(job.backup_objects, backupLayout); let databases: string[] = []; try { databases = JSON.parse(String(job.database_names || '[]')); } catch {} if (databaseScope === 'selected' && !databases.length) databases = connection.databases; if (backupLayout !== 'single' && databaseScope === 'all') databases = (await this.listAvailableDatabases(connection.id)).databases; if (databaseScope === 'selected' && !databases.length) throw new Error('No databases selected for this schedule'); const backupConnection: DatabaseConnection = { ...connection, databaseScope, databases, database: databaseScope === 'all' ? '*' : databases[0] || '' }; const target = this.storage.get(job.storage_target_id); tempDir = fs.mkdtempSync(path.join(this.store.dataDir, 'tmp', 'run-')); const databaseLabel = backupConnection.databaseScope === 'all' ? 'all-databases' : backupConnection.databases.join('-'); const raw = path.join(tempDir, `${safeFilePart(databaseLabel || backupConnection.database)}-${Date.now()}.sql`); const compression = backupLayout === 'single' && ['none', 'gzip', 'zip'].includes(job.compression) ? job.compression : backupLayout === 'single' ? 'gzip' : 'zip'; let artifact = raw;
      this.setProcessStage(runId, 'dumping'); this.addProcessLog(runId, `Dumping ${backupLayout === 'single' ? (databaseScope === 'all' ? 'all visible databases' : `${databases.length} selected database(s)`) : backupLayout === 'database' ? `${databases.length} database file(s)` : 'one SQL file per table'}`);
      if (backupLayout === 'single') { await this.dump(backupConnection, raw, runId); if (compression === 'gzip') { this.setProcessStage(runId, 'compressing'); this.addProcessLog(runId, 'Compressing SQL archive'); artifact = `${raw}.gz`; await pipeline(fs.createReadStream(raw), createGzip({ level: 6 }), fs.createWriteStream(artifact)); fs.rmSync(raw); } else if (compression === 'zip') { this.setProcessStage(runId, 'compressing'); this.addProcessLog(runId, 'Creating ZIP archive'); artifact = `${raw}.zip`; await this.writeZip([{ name: 'backup.sql', path: raw }], artifact); fs.rmSync(raw); } } else { const entries: Array<{ name: string; path: string }> = []; if (backupLayout === 'database') { for (const database of databases) { const output = path.join(tempDir, `${safeFilePart(database)}.sql`); await this.dumpDatabase(backupConnection, database, output, runId); entries.push({ name: `${safeFilePart(database)}/${safeFilePart(database)}.sql`, path: output }); } } else { for (const database of databases) { const available = await this.listAvailableTables(connection, database); const tables = available.tables; const databasePart = safeFilePart(database); if (available.views.length && !backupObjects.views) this.addProcessLog(runId, `Skipping ${available.views.length} view(s) in ${database} because view backup is disabled`); if (!backupObjects.triggers) this.addProcessLog(runId, `Skipping table triggers in ${database} because trigger backup is disabled`); if (!tables.length) this.addProcessLog(runId, `No base tables found in ${database}`); for (const table of tables) { const tablePart = safeFilePart(table); const output = path.join(tempDir, `${databasePart}-${tablePart}.sql`); await this.dumpTable(backupConnection, database, table, output, runId, backupObjects.triggers); entries.push({ name: `${databasePart}/${tablePart}.sql`, path: output }); } if (backupObjects.views || backupObjects.routines || backupObjects.events) { const objectsOutput = path.join(tempDir, `${databasePart}-objects.sql`); await this.dumpDatabaseObjects(backupConnection, database, available, backupObjects, objectsOutput, runId); if (this.containsDatabaseObjectSql(objectsOutput)) { entries.push({ name: `${databasePart}/_database-objects.sql`, path: objectsOutput }); this.addProcessLog(runId, `Included database objects for ${database}`); } else { fs.rmSync(objectsOutput, { force: true }); } } } } if (!entries.length) throw new Error('No databases or tables were available for the selected backup scope'); this.setProcessStage(runId, 'compressing'); this.addProcessLog(runId, `Creating ZIP archive with ${entries.length} SQL file(s)`); artifact = path.join(tempDir, `${safeFilePart(databaseLabel)}.zip`); await this.writeZip(entries, artifact); }
      if (job.backup_encryption === 'aes-256-gcm') { this.setProcessStage(runId, 'encrypting'); this.addProcessLog(runId, 'Encrypting backup archive'); const encrypted = `${artifact}.enc`; await this.encryptFile(artifact, encrypted); fs.rmSync(artifact); artifact = encrypted; }
      this.setProcessStage(runId, 'verifying'); this.addProcessLog(runId, 'Verifying archive contents');
      const filename = `${safeFilePart(job.filename_prefix)}-${new Date().toISOString().replace(/[:.]/g, '-')}.${compression === 'gzip' ? 'sql.gz' : compression === 'zip' ? 'zip' : 'sql'}${job.backup_encryption === 'aes-256-gcm' ? '.enc' : ''}`;
      const storageFolder = `schedule-${safeFilePart(jobId)}`;
      const verification = await this.verifyArtifact(artifact, compression, job.backup_encryption === 'aes-256-gcm', tempDir);
      const stats = fs.statSync(artifact); const hash = await this.sha256(artifact);
      this.setProcessStage(runId, 'uploading'); this.addProcessLog(runId, `Uploading ${filename}`);
      const uploaded = await this.storage.upload(target, artifact, filename, storageFolder);
      this.setProcessStage(runId, 'rotating'); this.addProcessLog(runId, 'Applying retention rotation');
      await this.storage.rotate(target, safeFilePart(job.filename_prefix), Number(job.retention_count), storageFolder);
      const finished = this.store.now(); this.store.db.prepare('UPDATE backup_runs SET status=?,finished_at=?,filename=?,storage_location=?,storage_folder=?,size_bytes=?,sha256=?,verification_status=?,verification_message=? WHERE id=?').run('success', finished, filename, uploaded.location, storageFolder, stats.size, hash, verification.status, verification.message, runId); this.store.db.prepare('UPDATE backup_jobs SET last_run_at=? WHERE id=?').run(finished, jobId); void this.system.notify('backup_success', `VaultBack backup succeeded: ${job.name || jobId} -> ${filename}`); return { ok: true, filename, sizeBytes: stats.size, sha256: hash, verification };
    } catch (error: any) { const message = String(error.message || error).slice(0, 1000); this.logger.error(`Backup ${jobId} failed: ${message}`); const retry = this.store.db.prepare('SELECT retry_count as retryCount,retry_delay_seconds as retryDelaySeconds FROM backup_jobs WHERE id=?').get(jobId) as any; const attempt = Number((this.store.db.prepare('SELECT attempt FROM backup_runs WHERE id=?').get(runId) as any)?.attempt || 1); const retryAvailable = attempt <= Number(retry?.retryCount || 0); this.setProcessStage(runId, 'failed', 'failed', retryAvailable ? `${message} — retry ${attempt}/${retry.retryCount} scheduled` : message); this.store.db.prepare('UPDATE backup_runs SET status=?,finished_at=?,error_message=?,verification_status=?,attempt=? WHERE id=?').run(retryAvailable ? 'retrying' : 'failed', this.store.now(), message, 'failed', attempt, runId); if (retryAvailable) { void this.system.notify('backup_retry', `VaultBack backup failed; retry ${attempt}/${retry.retryCount} scheduled: ${jobId}`); const delay = Math.max(30, Number(retry.retryDelaySeconds || 300)) * 1000; const timer = setTimeout(() => { void this.run(jobId).catch(retryError => this.logger.error(`Backup retry ${jobId} failed: ${retryError.message}`)); }, delay); timer.unref?.(); return { ok: false, retryScheduled: true, retryInSeconds: delay / 1000 }; } void this.system.notify('backup_failed', `VaultBack backup failed: ${jobId}\n${message}`); throw error; } finally { const process = this.liveProcessState.get(runId); if (process?.status === 'running') this.setProcessStage(runId, 'completed', 'success', 'Backup process finished'); this.running.delete(jobId); if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); if (this.queued.delete(jobId)) void this.run(jobId).catch(error => this.logger.error(`Queued backup ${jobId} failed: ${error.message}`)); }
  }
  private crc32Update(crc: number, data: Buffer) { let value = crc; for (const byte of data) value = ZIP_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8); return value >>> 0; }
  private async writeZip(entries: Array<{ name: string; path: string }>, output: string) {
    const stream = fs.createWriteStream(output, { mode: 0o600 }); let position = 0; const central: Array<{ name: Buffer; crc: number; compressedSize: number; uncompressedSize: number; offset: number }> = [];
    const write = async (data: Buffer) => { if (!stream.write(data)) await once(stream, 'drain'); position += data.length; };
    try {
      for (const entry of entries) {
        const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8'); if (!name.length || name.length > 0xffff) throw new Error('ZIP entry name is too long'); const offset = position;
        const header = Buffer.alloc(30 + name.length); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0808, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0, 10); header.writeUInt16LE(0, 12); header.writeUInt32LE(0, 14); header.writeUInt32LE(0, 18); header.writeUInt32LE(0, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28); name.copy(header, 30); await write(header);
        const deflater = createDeflateRaw({ level: 6 }); let crc = 0xffffffff; let uncompressedSize = 0; let compressedSize = 0;
        const compressedWriter = (async () => { for await (const chunk of deflater) { const data = Buffer.from(chunk as Buffer); compressedSize += data.length; await write(data); } })();
        try { for await (const chunk of fs.createReadStream(entry.path)) { const data = Buffer.from(chunk as Buffer); uncompressedSize += data.length; crc = this.crc32Update(crc, data); if (!deflater.write(data)) await once(deflater, 'drain'); } deflater.end(); await compressedWriter; } catch (error) { deflater.destroy(); throw error; }
        const finalCrc = (crc ^ 0xffffffff) >>> 0; const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(finalCrc, 4); descriptor.writeUInt32LE(compressedSize, 8); descriptor.writeUInt32LE(uncompressedSize, 12); await write(descriptor); central.push({ name, crc: finalCrc, compressedSize, uncompressedSize, offset });
      }
      const centralOffset = position; for (const entry of central) { const header = Buffer.alloc(46 + entry.name.length); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0808, 8); header.writeUInt16LE(8, 10); header.writeUInt16LE(0, 12); header.writeUInt16LE(0, 14); header.writeUInt32LE(entry.crc, 16); header.writeUInt32LE(entry.compressedSize, 20); header.writeUInt32LE(entry.uncompressedSize, 24); header.writeUInt16LE(entry.name.length, 28); header.writeUInt16LE(0, 30); header.writeUInt16LE(0, 32); header.writeUInt16LE(0, 34); header.writeUInt16LE(0, 36); header.writeUInt32LE(0, 38); header.writeUInt32LE(entry.offset, 42); entry.name.copy(header, 46); await write(header); }
      const centralSize = position - centralOffset; const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(centralOffset, 16); end.writeUInt16LE(0, 20); await write(end); await new Promise<void>((resolve, reject) => { stream.end((error?: Error | null) => error ? reject(error) : resolve()); });
    } catch (error) { stream.destroy(); throw error; }
  }
  private readAt(file: string, offset: number, length: number) { const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(length); try { let read = 0; while (read < length) { const count = fs.readSync(fd, buffer, read, length - read, offset + read); if (!count) break; read += count; } return buffer.subarray(0, read); } finally { fs.closeSync(fd); } }
  private readZipEntries(file: string): ZipEntry[] {
    const size = fs.statSync(file).size; const tailLength = Math.min(size, 22 + 0xffff); const tail = this.readAt(file, size - tailLength, tailLength); let end = -1; for (let index = tail.length - 22; index >= 0; index--) if (tail.readUInt32LE(index) === 0x06054b50) { end = index; break; } if (end < 0) throw new Error('ZIP archive directory is missing');
    const count = tail.readUInt16LE(end + 10); const centralSize = tail.readUInt32LE(end + 12); const centralOffset = tail.readUInt32LE(end + 16); if (count > 100000 || centralSize > 32 * 1024 * 1024 || centralOffset + centralSize > size) throw new Error('ZIP archive is too large or invalid'); const directory = this.readAt(file, centralOffset, centralSize); const entries: ZipEntry[] = []; let cursor = 0;
    for (let index = 0; index < count; index++) { if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP archive entry is invalid'); const flags = directory.readUInt16LE(cursor + 8); const method = directory.readUInt16LE(cursor + 10); const compressedSize = directory.readUInt32LE(cursor + 20); const uncompressedSize = directory.readUInt32LE(cursor + 24); const nameLength = directory.readUInt16LE(cursor + 28); const extraLength = directory.readUInt16LE(cursor + 30); const commentLength = directory.readUInt16LE(cursor + 32); const localOffset = directory.readUInt32LE(cursor + 42); const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'utf8'); if (!name || name.endsWith('/') || name.startsWith('/') || name.split('/').includes('..') || ![0, 8].includes(method)) throw new Error('ZIP archive contains an unsafe or unsupported entry'); entries.push({ name, method, compressedSize, uncompressedSize, localOffset }); cursor += 46 + nameLength + extraLength + commentLength; }
    return entries;
  }
  private async extractZipEntry(file: string, entry: ZipEntry, output: string) { const local = this.readAt(file, entry.localOffset, 30); if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP local entry is invalid'); const dataOffset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28); const source = fs.createReadStream(file, { start: dataOffset, end: dataOffset + entry.compressedSize - 1 }); await pipeline(source, entry.method === 8 ? createInflateRaw() : new PassThrough(), fs.createWriteStream(output, { mode: 0o600 })); }
  private async verifyZip(file: string, tempDir: string) { const entries = this.readZipEntries(file).filter(entry => entry.name.toLowerCase().endsWith('.sql')); if (!entries.length) throw new Error('ZIP archive does not contain SQL files'); const first = path.join(tempDir, 'verified.sql'); await this.extractZipEntry(file, entries[0], first); return this.readPrefix(first, 32768); }
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

  private async verifyArtifact(file: string, compression: 'none' | 'gzip' | 'zip', encrypted: boolean, tempDir: string) {
    let source = file; let intermediate = '';
    try {
      if (encrypted) { intermediate = path.join(tempDir, 'verified-artifact'); await this.decryptFile(source, intermediate); source = intermediate; }
      const preview = compression === 'gzip' ? await (async () => { const sqlFile = path.join(tempDir, 'verified.sql'); await pipeline(fs.createReadStream(source), createGunzip(), fs.createWriteStream(sqlFile, { mode: 0o600 })); return this.readPrefix(sqlFile, 32768); })() : compression === 'zip' ? await this.verifyZip(source, tempDir) : this.readPrefix(source, 32768);
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
  private spawnMysql(connection: DatabaseConnection, extraArgs: string[], inputFile?: string) { return new Promise<void>((resolve, reject) => { const binary = this.resolveClientBinary(connection.engine, false); const args = [...this.clientToolArgs(binary), `--host=${connection.host}`, `--port=${connection.port}`, `--user=${connection.username}`, '--connect-timeout=10', ...extraArgs]; if (connection.ssl) args.push('--ssl'); const env = { ...process.env }; if (connection.password) env.MYSQL_PWD = connection.password; else delete env.MYSQL_PWD; let child: ReturnType<typeof spawn>; try { child = spawn(binary, args, { env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }); } catch (error: any) { return reject(new BadRequestException(this.clientStartMessage(binary, error))); } let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk.toString(); }); const input = inputFile ? fs.createReadStream(inputFile) : undefined; const stdin = child.stdin; if (input) { if (!stdin) return reject(new BadRequestException('Unable to open database restore input')); input.pipe(stdin); } else stdin?.end(); input?.on('error', error => { child.kill(); reject(error); }); child.on('error', error => reject(new BadRequestException(this.clientStartMessage(binary, error)))); child.on('close', code => code === 0 ? resolve() : reject(new BadRequestException(`${binary} restore failed with code ${code}: ${stderr.slice(0, 1000)}`))); }); }
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
      try { child = spawn(binary, [...this.clientToolArgs(binary), '--version'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }); }
      catch { finish('corrupt'); return; }
      child.once('error', () => finish('corrupt'));
      child.once('close', code => finish(code === 0 ? 'working' : 'corrupt'));
    });
  }
  private clientToolArgs(binary: string) {
    const pluginDirectories = [
      path.resolve(path.dirname(binary), '..', 'lib', 'plugin'),
      path.resolve(path.dirname(binary), '..', 'lib', 'mariadb', 'plugin')
    ];
    const pluginDirectory = pluginDirectories.find(directory => {
      try { return fs.existsSync(directory) && fs.statSync(directory).isDirectory(); } catch { return false; }
    });
    return ['--no-defaults', ...(pluginDirectory ? [`--plugin-dir=${pluginDirectory}`] : [])];
  }
  private async verifyRestore(connection: DatabaseConnection, databases: string[]) {
    try {
      const details: Array<{ database: string; tables: number }> = [];
      await this.withNativeDatabaseConnection(connection, async client => {
        const [availableRows] = await client.query('SHOW DATABASES');
        const available = new Set((availableRows as any[]).map(row => String(row.Database || Object.values(row)[0] || '')));
        for (const database of databases.filter(Boolean)) {
          if (!available.has(database)) throw new Error(`Database ${database} was not found after restore`);
          const [rows] = await client.query('SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [database]);
          details.push({ database, tables: Number((rows as any[])[0]?.count || 0) });
        }
      });
      if (databases.length && details.every(item => item.tables === 0)) return { status: 'warning', message: 'Destination databases exist, but no tables were found', details };
      return { status: 'passed', message: `Verified ${details.length || 'the'} restored database connection${details.length === 1 ? '' : 's'}`, details };
    } catch (error: any) { return { status: 'failed', message: String(error?.message || error).slice(0, 500), details: {} }; }
  }
  private async listAvailableTables(connection: DatabaseConnection, database: string) {
    const [rows] = await this.withNativeDatabaseConnection<any>(connection, client => client.query('SELECT TABLE_NAME AS tableName, TABLE_TYPE AS tableType FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [database]));
    const tables: string[] = [];
    const views: string[] = [];
    for (const row of rows as any[]) {
      const entries = Object.entries(row);
      const valueFor = (field: string) => entries.find(([key]) => key.toLowerCase() === field.toLowerCase())?.[1];
      const name = String(valueFor('tableName') ?? entries[0]?.[1] ?? '').trim();
      if (!name) continue;
      const type = String(valueFor('tableType') ?? entries[1]?.[1] ?? '').toUpperCase();
      if (type === 'VIEW') views.push(name);
      else if (type === 'BASE TABLE') tables.push(name);
    }
    return { tables: [...new Set(tables)], views: [...new Set(views)] };
  }
  private containsDatabaseObjectSql(file: string) {
    try { return /\b(?:VIEW|PROCEDURE|FUNCTION|EVENT)\b/i.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
  }
  private dumpDatabaseObjects(connection: DatabaseConnection, database: string, available: { tables: string[]; views: string[] }, objects: BackupObjectOptions, output: string, processId?: string) {
    const ignored = [...available.tables, ...(objects.views ? [] : available.views)].map(name => `--ignore-table=${database}.${name}`);
    return this.dumpWithArgs(connection, output, ['--no-data', ...ignored, database], processId, { includeRoutines: objects.routines, includeEvents: objects.events, includeTriggers: false });
  }
  private clientStartMessage(binary: string, error: any) {
    if (error?.code === 'EPERM') return `Windows blocked VaultBack from launching ${path.basename(binary)}. Confirm the bundled tool is executable and run VaultBack under a Windows/PM2 account allowed to start child processes.`;
    if (error?.code === 'ENOENT') return `Bundled database tool not found: ${binary}. Open Settings and use Repair and redownload tools.`;
    return `Could not start ${binary}: ${error?.message || error}`;
  }
  private dump(connection: DatabaseConnection, output: string, processId?: string) { const dumpArgs = connection.databaseScope === 'all' ? ['--all-databases'] : ['--databases', ...connection.databases]; return this.dumpWithArgs(connection, output, dumpArgs, processId); }
  private dumpDatabase(connection: DatabaseConnection, database: string, output: string, processId?: string) { return this.dumpWithArgs(connection, output, ['--databases', database], processId); }
  private dumpTable(connection: DatabaseConnection, database: string, table: string, output: string, processId?: string, includeTriggers = true) { return this.dumpWithArgs(connection, output, [database, table], processId, { includeRoutines: false, includeEvents: false, includeTriggers }); }
  private dumpWithArgs(connection: DatabaseConnection, output: string, dumpArgs: string[], processId?: string, options: { includeRoutines?: boolean; includeEvents?: boolean; includeTriggers?: boolean } = {}) { return new Promise<void>((resolve, reject) => { const binary = this.resolveClientBinary(connection.engine, true); const transportArgs = connection.ssl ? ['--ssl'] : ['--skip-ssl']; const args = [...this.clientToolArgs(binary), `--host=${connection.host}`, `--port=${connection.port}`, `--user=${connection.username}`, ...transportArgs, '--single-transaction', ...(options.includeRoutines === false ? [] : ['--routines']), ...(options.includeEvents === false ? [] : ['--events']), ...(options.includeTriggers === false ? [] : ['--triggers']), '--hex-blob', ...dumpArgs]; const child = spawn(binary, args, { env: { ...process.env, MYSQL_PWD: connection.password }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); const out = fs.createWriteStream(output, { mode: 0o600 }); let stderr = ''; child.stdout.pipe(out); child.stderr.on('data', chunk => { const text = chunk.toString(); stderr += text; if (processId) this.addProcessLog(processId, text); }); child.on('error', error => { out.close(); if (processId) this.addProcessLog(processId, this.clientStartMessage(binary, error)); reject(new Error(this.clientStartMessage(binary, error))); }); child.on('close', code => { out.close(); if (code === 0) resolve(); else reject(new Error(`${binary} failed with code ${code}: ${stderr.slice(0, 800)}`)); }); }); }
  private async sha256(file: string) { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
}
