import { BadRequestException, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { StorageDownloadProgress, StorageService } from '../storage/storage.service';
import { DatabaseService } from '../database/database.service';
import { BackupJob, BackupObjectOptions, DatabaseConnection, StorageTarget } from '../types';
import { ensureDirectory, isWithin, nextCron, safeFilePart } from './backup.utils';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createDeflateRaw, createGzip, createGunzip, createInflateRaw, inflateRawSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createDecipheriv, createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough, Transform } from 'node:stream';
import { SystemService } from '../system/system.service';
import { createConnection } from 'mysql2/promise';
import { RealtimeService } from '../system/realtime.service';
import { findBinlogSequenceGaps, makeScratchDatabaseNames, parseDumpBinlogCoordinates, parseUtcTargetTime, pitrBinlogReplayOptions, pitrBinlogTransportOptions, pitrDumpCoordinateOption, rewritePitrSqlDatabases, validatePitrSql } from './pitr.utils';

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
type DownloadPreparation = {
  id: string;
  userId: string;
  runId: string;
  filename: string;
  state: 'preparing' | 'ready' | 'failed';
  percent: number;
  stage: 'checking' | 'connecting' | 'downloading' | 'finalizing' | 'ready' | 'failed';
  message: string;
  path?: string;
  cleanup?: boolean;
  error?: string;
  updatedAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};
type ZipEntry = { name: string; method: number; compressedSize: number; uncompressedSize: number; localOffset: number };
class TempStorageLimitTransform extends Transform {
  private bytes = 0;
  constructor(private readonly limit: number) { super(); }
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) { callback(new BadRequestException(`Restore expansion exceeds available temporary storage (${this.limit} bytes)`)); return; }
    callback(null, chunk);
  }
}
const ZIP_CRC_TABLE = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1; return value >>> 0; });

@Injectable()
export class BackupService implements OnApplicationShutdown {
  private readonly logger = new Logger(BackupService.name);
  private readonly running = new Set<string>();
  private readonly queued = new Set<string>();
  private readonly liveProcessState = new Map<string, LiveBackupProcess>();
  private readonly downloadPreparations = new Map<string, DownloadPreparation>();
  private readonly pitrCapturing = new Set<string>();
  private readonly workClaimTokens = new Map<string, string>();
  private shuttingDown = false;
  constructor(private readonly store: DatabaseService, private readonly storage: StorageService, private readonly system: SystemService, private readonly realtime: RealtimeService) {}

  onApplicationShutdown(signal?: string) {
    this.shuttingDown = true;
    const message = `Application shutting down${signal ? ` (${signal})` : ''}`;
    for (const [runId, process] of this.liveProcessState) {
      if (process.status !== 'running') continue;
      this.setProcessStage(runId, 'failed', 'failed', message);
      this.store.db.prepare('UPDATE backup_runs SET status=?,finished_at=?,error_message=?,verification_status=? WHERE id=? AND status=?').run('failed', this.store.now(), message, 'failed', runId, 'running');
    }
    this.running.clear();
    this.queued.clear();
    for (const preparation of this.downloadPreparations.values()) clearTimeout(preparation.cleanupTimer);
    this.downloadPreparations.clear();
  }

  private pageOptions(input: any = {}) { const page = Math.max(1, Number.parseInt(String(input.page || '1'), 10) || 1); const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(input.pageSize || '25'), 10) || 25)); return { page, pageSize, offset: (page - 1) * pageSize, search: String(input.search || '').trim().toLowerCase() }; }
  private acquireWorkClaim(key: string, message: string) {
    if (this.workClaimTokens.has(key)) throw new BadRequestException(message);
    const token = crypto.randomUUID();
    const claimDirectory = path.join(this.store.dataDir, 'tmp', 'claims');
    fs.mkdirSync(claimDirectory, { recursive: true, mode: 0o700 });
    const claimPath = path.join(claimDirectory, `${crypto.createHash('sha256').update(key).digest('hex')}.claim`);
    let claimed = false;
    for (let attempt = 0; attempt < 2 && !claimed; attempt++) {
      try {
        const fd = fs.openSync(claimPath, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ key, token, processId: process.pid, claimedAt: this.store.now() })); }
        finally { fs.closeSync(fd); }
        claimed = true;
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        let owner: any = null;
        try { owner = JSON.parse(fs.readFileSync(claimPath, 'utf8')); } catch {}
        const ownerPid = Number(owner?.processId);
        let alive = false;
        if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
          try { process.kill(ownerPid, 0); alive = true; }
          catch (probeError: any) { alive = probeError?.code === 'EPERM'; }
        }
        if (alive) throw new BadRequestException(message);
        try { fs.rmSync(claimPath, { force: true }); } catch { throw new BadRequestException(message); }
      }
    }
    if (!claimed) throw new BadRequestException(message);
    try {
      this.store.db.prepare('DELETE FROM work_claims WHERE claim_key=?').run(key);
      this.store.db.prepare('INSERT INTO work_claims (claim_key,claim_token,process_id,claimed_at) VALUES (?,?,?,?)').run(key, token, process.pid, this.store.now());
      this.workClaimTokens.set(key, token);
      return token;
    } catch (error) {
      try { fs.rmSync(claimPath, { force: true }); } catch {}
      throw error;
    }
  }
  private releaseWorkClaim(key: string, token: string) {
    if (this.workClaimTokens.get(key) && this.workClaimTokens.get(key) !== token) return;
    this.workClaimTokens.delete(key);
    try { this.store.db.prepare('DELETE FROM work_claims WHERE claim_key=? AND claim_token=?').run(key, token); } catch {}
    const claimPath = path.join(this.store.dataDir, 'tmp', 'claims', `${crypto.createHash('sha256').update(key).digest('hex')}.claim`);
    try {
      const owner = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
      if (owner.token === token) fs.rmSync(claimPath, { force: true });
    } catch {}
  }
  private temporaryFileLimitBytes() {
    const stat = (fs as any).statfsSync(this.store.dataDir);
    const free = Number(stat.bavail) * Number(stat.bsize);
    const reserve = Math.max(256 * 1024 * 1024, Math.floor(free * 0.05));
    const limit = Math.min(64 * 1024 * 1024 * 1024, free - reserve);
    if (!Number.isFinite(limit) || limit < 1024 * 1024) throw new BadRequestException('Not enough free temporary storage to safely restore this artifact');
    return limit;
  }
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
    const { page, pageSize, offset, search } = this.pageOptions(input); const where = search ? `WHERE COALESCE(connection_purpose,'backup') <> 'recovery' AND LOWER(COALESCE(name,'') || ' ' || COALESCE(engine,'') || ' ' || COALESCE(host,'') || ' ' || COALESCE(username,'') || ' ' || COALESCE(database_name,'')) LIKE ?` : `WHERE COALESCE(connection_purpose,'backup') <> 'recovery'`; const params = search ? [`%${search}%`] : []; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM database_connections ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT id, name, engine, host, port, username, database_name as database, database_scope as databaseScope, database_names as databaseNames, ssl, created_at as createdAt FROM database_connections ${where} ORDER BY name LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; const items = rows.map(row => { const databaseScope = row.databaseScope === 'all' ? 'all' : 'selected'; let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} if (databaseScope === 'selected' && !databases.length && row.database) databases = String(row.database).split(',').map(value => value.trim()).filter(Boolean); return { ...row, database: databaseScope === 'all' ? '*' : databases.join(', '), databaseScope, databases }; }); return this.pageResult(items, total, page, pageSize);
  }

  listJobsPage(input: any = {}) {
    const { page, pageSize, offset, search } = this.pageOptions(input); const where = search ? `WHERE LOWER(COALESCE(j.name,'') || ' ' || COALESCE(j.cron_expression,'') || ' ' || COALESCE(j.timezone,'') || ' ' || COALESCE(j.filename_prefix,'') || ' ' || COALESCE(c.name,'') || ' ' || COALESCE(s.name,'')) LIKE ?` : ''; const params = search ? [`%${search}%`] : []; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_jobs j LEFT JOIN database_connections c ON c.id=j.database_connection_id LEFT JOIN storage_targets s ON s.id=j.storage_target_id ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT j.id,j.name,j.database_connection_id as databaseConnectionId,j.storage_target_id as storageTargetId,j.database_scope as databaseScope,j.database_names as databaseNames,j.backup_layout as backupLayout,j.backup_objects as backupObjects,j.insert_mode as insertMode,j.cron_expression as cronExpression,j.timezone,j.enabled,j.compression,j.backup_encryption as backupEncryption,j.retention_count as retentionCount,j.retry_count as retryCount,j.retry_delay_seconds as retryDelaySeconds,j.overlap_policy as overlapPolicy,j.filename_prefix as filenamePrefix,j.next_run_at as nextRunAt,j.last_run_at as lastRunAt,j.created_at as createdAt FROM backup_jobs j LEFT JOIN database_connections c ON c.id=j.database_connection_id LEFT JOIN storage_targets s ON s.id=j.storage_target_id ${where} ORDER BY j.name LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; const items = rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} const backupLayout = ['database', 'table'].includes(row.backupLayout) ? row.backupLayout : 'single'; return { ...row, databaseScope: row.databaseScope === 'all' ? 'all' : 'selected', backupLayout, backupObjects: this.backupObjects(row.backupObjects, backupLayout), databases }; }); const activeTotal = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_jobs j LEFT JOIN database_connections c ON c.id=j.database_connection_id LEFT JOIN storage_targets s ON s.id=j.storage_target_id ${where} ${where ? 'AND' : 'WHERE'} j.enabled=1`).get(...params) as any)?.count || 0); return this.pageResult(items, total, page, pageSize, { activeTotal });
  }

  runsPage(input: any = {}) {
    const { page, pageSize, offset, search } = this.pageOptions(input); const status = ['success', 'failed', 'running'].includes(String(input.status)) ? String(input.status) : ''; const conditions: string[] = []; const params: any[] = []; if (status) { conditions.push('r.status=?'); params.push(status); } if (search) { conditions.push(`LOWER(COALESCE(j.name,'') || ' ' || COALESCE(r.filename,'') || ' ' || COALESCE(r.error_message,'')) LIKE ?`); params.push(`%${search}%`); } const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT r.id,r.job_id as jobId,j.name as jobName,r.database_connection_id as databaseConnectionId,c.name as connectionName,r.database_scope as databaseScope,r.database_names as databaseNames,r.storage_target_id as storageTargetId,s.name as storageTargetName,r.backup_layout as backupLayout,r.backup_objects as backupObjects,r.compression,r.backup_encryption as backupEncryption,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.storage_location as storageLocation,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id LEFT JOIN database_connections c ON c.id=r.database_connection_id LEFT JOIN storage_targets s ON s.id=r.storage_target_id ${where} ORDER BY r.started_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; const items = rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} return { ...row, databases }; }); const stats = this.store.db.prepare(`SELECT SUM(CASE WHEN r.status='success' THEN 1 ELSE 0 END) as successTotal,SUM(CASE WHEN r.status='failed' THEN 1 ELSE 0 END) as failedTotal,SUM(CASE WHEN r.status='failed' AND NOT EXISTS (SELECT 1 FROM backup_runs later JOIN backup_jobs later_job ON later_job.id=later.job_id WHERE later.job_id=r.job_id AND later.status='success' AND COALESCE(later.storage_target_id,later_job.storage_target_id)=COALESCE(r.storage_target_id,j.storage_target_id) AND COALESCE(later.database_connection_id,later_job.database_connection_id)=COALESCE(r.database_connection_id,j.database_connection_id) AND COALESCE(later.finished_at,later.started_at)>COALESCE(r.finished_at,r.started_at)) THEN 1 ELSE 0 END) as attentionTotal FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id ${where}`).get(...params) as any; return this.pageResult(items, total, page, pageSize, { successTotal: Number(stats?.successTotal || 0), failedTotal: Number(stats?.failedTotal || 0), attentionTotal: Number(stats?.attentionTotal || 0) });
  }

  runsForJobPage(jobId: string, input: any = {}) { const { page, pageSize, offset, search } = this.pageOptions(input); const where = search ? `AND LOWER(COALESCE(r.filename,'')) LIKE ?` : ''; const params = search ? [jobId, `%${search}%`] : [jobId]; const total = Number((this.store.db.prepare(`SELECT COUNT(*) as count FROM backup_runs r WHERE r.job_id=? AND r.status='success' AND r.filename IS NOT NULL AND TRIM(r.filename) <> '' ${where}`).get(...params) as any)?.count || 0); const rows = this.store.db.prepare(`SELECT r.id,r.job_id as jobId,j.name as jobName,r.database_connection_id as databaseConnectionId,c.name as connectionName,r.database_scope as databaseScope,r.database_names as databaseNames,r.storage_target_id as storageTargetId,s.name as storageTargetName,r.backup_layout as backupLayout,r.backup_objects as backupObjects,r.compression,r.backup_encryption as backupEncryption,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.storage_location as storageLocation,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id LEFT JOIN database_connections c ON c.id=r.database_connection_id LEFT JOIN storage_targets s ON s.id=r.storage_target_id WHERE r.job_id=? AND r.status='success' AND r.filename IS NOT NULL AND TRIM(r.filename) <> '' ${where} ORDER BY r.started_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]; return this.pageResult(rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} return { ...row, databases }; }), total, page, pageSize); }
  async reconcileMissingArtifacts() {
    const rows = this.store.db.prepare(`SELECT r.id,r.filename,r.storage_location as storageLocation,r.storage_folder as storageFolder,COALESCE(r.storage_target_id,j.storage_target_id) as storageTargetId FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id WHERE r.status='success' AND r.filename IS NOT NULL AND TRIM(r.filename) <> '' ORDER BY r.started_at DESC`).all() as any[];
    let checked = 0; let expired = 0; let errors = 0;
    const errorItems: Array<{ runId: string; message: string }> = [];
    for (const row of rows) {
      checked++;
      try {
        const target = this.storage.get(String(row.storageTargetId || ''));
        const available = await this.storage.isAvailable(target, String(row.filename), row.storageLocation ? String(row.storageLocation) : undefined, row.storageFolder ? String(row.storageFolder) : '');
        if (!available) {
          this.store.db.prepare(`UPDATE backup_runs SET status='expired',verification_status='expired',verification_message='Backup file was not found during reconciliation' WHERE id=? AND status='success'`).run(row.id);
          expired++;
        }
      } catch (error: any) {
        errors++;
        if (errorItems.length < 20) errorItems.push({ runId: String(row.id), message: String(error?.message || error).slice(0, 300) });
      }
    }
    return { ok: true, checked, expired, available: checked - expired - errors, errors, errorItems, completedAt: this.store.now() };
  }

  backupActivity(input: any = {}) {
    const requestedDays = Number.parseInt(String(input.days || '182'), 10) || 182;
    const days = Math.min(366, Math.max(28, requestedDays));
    const end = new Date();
    const endUtc = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    const startUtc = new Date(endUtc);
    startUtc.setUTCDate(startUtc.getUTCDate() - (days - 1));
    const from = startUtc.toISOString().slice(0, 10);
    const to = endUtc.toISOString().slice(0, 10);
    const rows = this.store.db.prepare(`SELECT substr(COALESCE(finished_at,started_at),1,10) as date,SUM(CASE WHEN status IN ('success','expired') THEN 1 ELSE 0 END) as successCount,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failedCount,SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as runningCount,SUM(CASE WHEN status IN ('success','expired','failed','running') THEN 1 ELSE 0 END) as totalCount FROM backup_runs WHERE substr(COALESCE(finished_at,started_at),1,10) BETWEEN ? AND ? GROUP BY substr(COALESCE(finished_at,started_at),1,10) ORDER BY date`).all(from, to) as any[];
    const byDate = new Map(rows.map(row => [String(row.date), row]));
    const calendar: Array<{ date: string; success: number; failed: number; running: number; total: number }> = [];
    for (let cursor = new Date(startUtc); cursor <= endUtc; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10);
      const row = byDate.get(date) || {};
      calendar.push({ date, success: Number(row.successCount || 0), failed: Number(row.failedCount || 0), running: Number(row.runningCount || 0), total: Number(row.totalCount || 0) });
    }
    return { from, to, days: calendar, successTotal: calendar.reduce((sum, day) => sum + day.success, 0), failedTotal: calendar.reduce((sum, day) => sum + day.failed, 0), runningTotal: calendar.reduce((sum, day) => sum + day.running, 0) };
  }

  liveProcesses() {
    const expiry = Date.now() - 15 * 60 * 1000;
    for (const [id, process] of this.liveProcessState) if (process.status !== 'running' && Date.parse(process.updatedAt) < expiry) this.liveProcessState.delete(id);
    const items = [...this.liveProcessState.values()].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return { items, updatedAt: this.store.now() };
  }

  listConnections() {
    const rows = this.store.db.prepare("SELECT id, name, engine, host, port, username, database_name as database, database_scope as databaseScope, database_names as databaseNames, ssl, created_at as createdAt FROM database_connections WHERE COALESCE(connection_purpose,'backup') <> 'recovery' ORDER BY name").all() as any[];
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
    const id = body.id || crypto.randomUUID(); const old = this.store.db.prepare('SELECT password_enc,database_name,connection_purpose FROM database_connections WHERE id = ?').get(id) as any; if (old?.connection_purpose === 'recovery') throw new BadRequestException('Dedicated recovery connections must be managed in Recovery Assurance');
    const hasNewPassword = typeof body.password === 'string' && body.password.length > 0;
    const passwordEnc = hasNewPassword ? this.store.encrypt(body.password) : (old?.password_enc || this.store.encrypt(''));
    const legacyDatabase = body.database || old?.database_name || '';
    this.store.db.prepare(`INSERT INTO database_connections (id,name,engine,host,port,username,password_enc,database_name,database_scope,database_names,ssl,connection_purpose,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,engine=excluded.engine,host=excluded.host,port=excluded.port,username=excluded.username,password_enc=excluded.password_enc,database_name=excluded.database_name,ssl=excluded.ssl,connection_purpose='backup'`).run(id, body.name, body.engine || 'mysql', body.host, Number(body.port || 3306), body.username, passwordEnc, legacyDatabase, 'selected', '[]', body.ssl ? 1 : 0, 'backup', this.store.now());
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
  deleteConnection(id: string) { this.store.db.prepare("DELETE FROM database_connections WHERE id = ? AND COALESCE(connection_purpose,'backup') <> 'recovery'").run(id); return { ok: true }; }
  async listAvailableDatabases(id: string) {
    const purpose = this.store.db.prepare("SELECT connection_purpose FROM database_connections WHERE id=?").get(id) as any;
    if (purpose?.connection_purpose === 'recovery') throw new BadRequestException('Dedicated recovery connections are not available for backup database discovery');
    const connection = this.getConnection(id);
    try {
      const [rows] = await this.withNativeDatabaseConnection<any>(connection, client => client.query('SHOW DATABASES'));
      const databases = (rows as any[]).map(row => String(row.Database || Object.values(row)[0] || '').trim()).filter(Boolean);
      return { databases: [...new Set(databases)] };
    } catch (error: any) {
      throw new BadRequestException(this.nativeClientMessage(error));
    }
  }
  private jobConnectionLinks(jobId: string, row?: any) {
    const links = this.store.db.prepare('SELECT connection_id as connectionId,database_names as databaseNames,position FROM backup_job_connections WHERE job_id=? ORDER BY position,connection_id').all(jobId) as any[];
    if (links.length) return links.map(link => { let databases: string[] = []; try { databases = JSON.parse(String(link.databaseNames || '[]')); } catch {} return { connectionId: String(link.connectionId), databases }; });
    if (!row?.databaseConnectionId) return [];
    let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {}
    return [{ connectionId: String(row.databaseConnectionId), databases }];
  }
  private jobStorageLinks(jobId: string, row?: any) {
    const links = this.store.db.prepare('SELECT storage_target_id as storageTargetId,position FROM backup_job_storages WHERE job_id=? ORDER BY position,storage_target_id').all(jobId) as any[];
    if (links.length) return links.map(link => String(link.storageTargetId));
    return row?.storageTargetId ? [String(row.storageTargetId)] : [];
  }
  private enrichJob(row: any) {
    const backupLayout = ['database', 'table'].includes(row.backupLayout) ? row.backupLayout : 'single';
    let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {}
    const connections = this.jobConnectionLinks(String(row.id), row);
    const storageTargetIds = this.jobStorageLinks(String(row.id), row);
    return { ...row, databaseScope: row.databaseScope === 'all' ? 'all' : 'selected', backupLayout, backupObjects: this.backupObjects(row.backupObjects, backupLayout), databases, databaseConnectionIds: connections.map(item => item.connectionId), storageTargetIds, databaseSelections: connections.map(item => ({ connectionId: item.connectionId, databases: item.databases })) };
  }
  listJobsPageV2(input: any = {}) {
    const result = this.listJobsPage(input);
    return { ...result, items: result.items.map((row: any) => this.enrichJob(row)) };
  }
  listJobsV2() {
    return this.listJobs().map((row: any) => this.enrichJob(row));
  }
  saveJobV2(body: any) {
    if (!body.name || !body.cronExpression) throw new BadRequestException('Name and schedule are required');
    const connectionIds = [...new Set((Array.isArray(body.connectionIds) ? body.connectionIds : [body.databaseConnectionId]).map((value: unknown) => String(value || '').trim()).filter(Boolean))];
    const storageTargetIds = [...new Set((Array.isArray(body.storageTargetIds) ? body.storageTargetIds : [body.storageTargetId]).map((value: unknown) => String(value || '').trim()).filter(Boolean))];
    if (!connectionIds.length || !storageTargetIds.length) throw new BadRequestException('Select at least one database connection and storage target');
    for (const id of connectionIds) if (!this.store.db.prepare("SELECT id FROM database_connections WHERE id=? AND COALESCE(connection_purpose,'backup') <> 'recovery'").get(id)) throw new BadRequestException('One selected database connection no longer exists');
    for (const id of storageTargetIds) if (!this.store.db.prepare('SELECT id FROM storage_targets WHERE id=?').get(id)) throw new BadRequestException('One selected storage target no longer exists');
    const databaseScope = body.databaseScope === 'all' ? 'all' : 'selected';
    const rawSelections = Array.isArray(body.databaseSelections) ? body.databaseSelections : [];
    const selections = connectionIds.map(connectionId => {
      const source = rawSelections.find((item: any) => String(item?.connectionId) === connectionId);
      const databases = [...new Set((Array.isArray(source?.databases) ? source.databases : connectionIds.length === 1 && Array.isArray(body.databases) ? body.databases : []).map((value: unknown) => String(value).trim()).filter(Boolean))];
      return { connectionId, databases };
    });
    if (databaseScope === 'selected' && !selections.some(item => item.databases.length)) throw new BadRequestException('Select at least one database from the grouped connection lists');
    const databases = [...new Set(selections.flatMap(item => item.databases))];
    const backupLayout = ['database', 'table'].includes(body.backupLayout) ? body.backupLayout : 'single';
    const backupObjects = this.backupObjects(body.backupObjects, backupLayout);
    const savedInsertMode = body.id && body.insertMode === undefined
      ? (this.store.db.prepare('SELECT insert_mode FROM backup_jobs WHERE id=?').get(body.id) as { insert_mode?: string } | undefined)?.insert_mode
      : undefined;
    const insertMode = (body.insertMode ?? savedInsertMode) === 'single-row' ? 'single-row' : 'extended';
    const timezone = body.timezone || 'UTC'; nextCron(body.cronExpression, new Date(), timezone);
    const id = body.id || crypto.randomUUID(); const prefix = safeFilePart(body.filenamePrefix || body.name); const next = nextCron(body.cronExpression, new Date(), timezone).toISOString();
    const encryption = body.backupEncryption === 'aes-256-gcm' ? 'aes-256-gcm' : 'none'; const requestedCompression = ['none', 'gzip', 'zip'].includes(body.compression) ? body.compression : 'gzip'; const compression = backupLayout === 'single' ? requestedCompression : 'zip';
    const retryCount = Math.max(0, Math.min(10, Number(body.retryCount || 0))); const retryDelaySeconds = Math.max(30, Math.min(86400, Number(body.retryDelaySeconds || 300))); const overlapPolicy = body.overlapPolicy === 'queue' ? 'queue' : 'skip';
    this.store.db.prepare(`INSERT INTO backup_jobs (id,name,database_connection_id,storage_target_id,database_scope,database_names,backup_layout,backup_objects,insert_mode,cron_expression,timezone,enabled,compression,backup_encryption,retention_count,retry_count,retry_delay_seconds,overlap_policy,filename_prefix,next_run_at,last_run_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,database_connection_id=excluded.database_connection_id,storage_target_id=excluded.storage_target_id,database_scope=excluded.database_scope,database_names=excluded.database_names,backup_layout=excluded.backup_layout,backup_objects=excluded.backup_objects,insert_mode=excluded.insert_mode,cron_expression=excluded.cron_expression,timezone=excluded.timezone,enabled=excluded.enabled,compression=excluded.compression,backup_encryption=excluded.backup_encryption,retention_count=excluded.retention_count,retry_count=excluded.retry_count,retry_delay_seconds=excluded.retry_delay_seconds,overlap_policy=excluded.overlap_policy,filename_prefix=excluded.filename_prefix,next_run_at=excluded.next_run_at`).run(id, body.name, connectionIds[0], storageTargetIds[0], databaseScope, JSON.stringify(databases), backupLayout, JSON.stringify(backupObjects), insertMode, body.cronExpression, timezone, body.enabled === false ? 0 : 1, compression, encryption, Math.max(1, Math.min(365, Number(body.retentionCount || 7))), retryCount, retryDelaySeconds, overlapPolicy, prefix, next, body.lastRunAt || null, this.store.now());
    this.store.db.prepare('DELETE FROM backup_job_connections WHERE job_id=?').run(id); this.store.db.prepare('DELETE FROM backup_job_storages WHERE job_id=?').run(id);
    selections.forEach((item, position) => this.store.db.prepare('INSERT INTO backup_job_connections (job_id,connection_id,database_names,position) VALUES (?,?,?,?)').run(id, item.connectionId, JSON.stringify(item.databases), position));
    storageTargetIds.forEach((targetId, position) => this.store.db.prepare('INSERT INTO backup_job_storages (job_id,storage_target_id,position) VALUES (?,?,?)').run(id, targetId, position));
    return this.listJobsV2().find((item: any) => item.id === id);
  }
   listJobs() { const rows = this.store.db.prepare('SELECT id,name,database_connection_id as databaseConnectionId,storage_target_id as storageTargetId,database_scope as databaseScope,database_names as databaseNames,backup_layout as backupLayout,backup_objects as backupObjects,insert_mode as insertMode,cron_expression as cronExpression,timezone,enabled,compression,backup_encryption as backupEncryption,retention_count as retentionCount,retry_count as retryCount,retry_delay_seconds as retryDelaySeconds,overlap_policy as overlapPolicy,filename_prefix as filenamePrefix,next_run_at as nextRunAt,last_run_at as lastRunAt,created_at as createdAt FROM backup_jobs ORDER BY name').all() as any[]; return rows.map(row => { let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {} const backupLayout = ['database', 'table'].includes(row.backupLayout) ? row.backupLayout : 'single'; return { ...row, databaseScope: row.databaseScope === 'all' ? 'all' : 'selected', backupLayout, backupObjects: this.backupObjects(row.backupObjects, backupLayout), databases }; }); }
   saveJob(body: any) { if (!body.name || !body.databaseConnectionId || !body.storageTargetId || !body.cronExpression) throw new BadRequestException('Name, database, storage, and schedule are required'); const databaseScope = body.databaseScope === 'all' ? 'all' : 'selected'; const rawDatabases = Array.isArray(body.databases) ? body.databases : String(body.databases ?? '').split(/[\n,]/); const databases = [...new Set(rawDatabases.map((value: unknown) => String(value).trim()).filter(Boolean))]; if (databaseScope === 'selected' && !databases.length) throw new BadRequestException('Select at least one database'); const backupLayout = ['database', 'table'].includes(body.backupLayout) ? body.backupLayout : 'single'; const backupObjects = this.backupObjects(body.backupObjects, backupLayout); const timezone = body.timezone || 'UTC'; nextCron(body.cronExpression, new Date(), timezone); const id = body.id || crypto.randomUUID(); const prefix = safeFilePart(body.filenamePrefix || body.name); const next = nextCron(body.cronExpression, new Date(), timezone).toISOString(); const encryption = body.backupEncryption === 'aes-256-gcm' ? 'aes-256-gcm' : 'none'; const requestedCompression = ['none', 'gzip', 'zip'].includes(body.compression) ? body.compression : 'gzip'; const compression = backupLayout === 'single' ? requestedCompression : 'zip'; const retryCount = Math.max(0, Math.min(10, Number(body.retryCount || 0))); const retryDelaySeconds = Math.max(30, Math.min(86400, Number(body.retryDelaySeconds || 300))); const overlapPolicy = body.overlapPolicy === 'queue' ? 'queue' : 'skip'; this.store.db.prepare(`INSERT INTO backup_jobs (id,name,database_connection_id,storage_target_id,database_scope,database_names,backup_layout,backup_objects,cron_expression,timezone,enabled,compression,backup_encryption,retention_count,retry_count,retry_delay_seconds,overlap_policy,filename_prefix,next_run_at,last_run_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,database_connection_id=excluded.database_connection_id,storage_target_id=excluded.storage_target_id,database_scope=excluded.database_scope,database_names=excluded.database_names,backup_layout=excluded.backup_layout,backup_objects=excluded.backup_objects,cron_expression=excluded.cron_expression,timezone=excluded.timezone,enabled=excluded.enabled,compression=excluded.compression,backup_encryption=excluded.backup_encryption,retention_count=excluded.retention_count,retry_count=excluded.retry_count,retry_delay_seconds=excluded.retry_delay_seconds,overlap_policy=excluded.overlap_policy,filename_prefix=excluded.filename_prefix,next_run_at=excluded.next_run_at`).run(id, body.name, body.databaseConnectionId, body.storageTargetId, databaseScope, JSON.stringify(databases), backupLayout, JSON.stringify(backupObjects), body.cronExpression, timezone, body.enabled === false ? 0 : 1, compression, encryption, Math.max(1, Math.min(365, Number(body.retentionCount || 7))), retryCount, retryDelaySeconds, overlapPolicy, prefix, next, body.lastRunAt || null, this.store.now()); return this.listJobs().find((x: any) => x.id === id); }
  deleteJob(id: string) { this.store.db.prepare('DELETE FROM backup_job_connections WHERE job_id=?').run(id); this.store.db.prepare('DELETE FROM backup_job_storages WHERE job_id=?').run(id); this.store.db.prepare('DELETE FROM backup_jobs WHERE id = ?').run(id); return { ok: true }; }
   runs(filters: { status?: string; search?: string } = {}) { const where = filters.status && ['success','failed','running'].includes(filters.status) ? 'WHERE r.status=?' : ''; const params = where ? [filters.status] : []; const rows = this.store.db.prepare(`SELECT r.id,r.job_id as jobId,j.name as jobName,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id ${where} ORDER BY r.started_at DESC LIMIT 100`).all(...params); return filters.search ? rows.filter((row: any) => `${row.jobName} ${row.filename || ''}`.toLowerCase().includes(filters.search!.toLowerCase())) : rows; }
   runsForJob(jobId: string) { return this.store.db.prepare('SELECT r.id,r.job_id as jobId,j.name as jobName,s.name as storageTargetName,r.status,r.started_at as startedAt,r.finished_at as finishedAt,r.filename,r.size_bytes as sizeBytes,r.sha256,r.verification_status as verificationStatus,r.verification_message as verificationMessage,r.error_message as errorMessage FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id JOIN storage_targets s ON s.id=j.storage_target_id WHERE r.job_id=? ORDER BY r.started_at DESC LIMIT 100').all(jobId); }
  async runDue() { if (this.shuttingDown) return; const jobs = this.store.db.prepare('SELECT * FROM backup_jobs WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at').all(this.store.now()) as any[]; for (const job of jobs) { if (this.running.has(job.id)) { if (job.overlap_policy === 'queue') { this.queued.add(job.id); this.logger.warn(`Backup ${job.id} is already running; overlap queued by schedule policy`); } else void this.system.notifyOnce('backup_failed', `overlap:${job.id}`, `VaultBack skipped overlapping backup: ${job.name || job.id}`); continue; } this.store.db.prepare('UPDATE backup_jobs SET next_run_at=? WHERE id=?').run(nextCron(job.cron_expression, new Date(), job.timezone || 'UTC').toISOString(), job.id); void this.run(job.id).catch((error: any) => this.logger.error(`Scheduled backup ${job.id} failed: ${error.message}`)); } }
  async runNow(id: string) { if (this.shuttingDown) throw new BadRequestException('VaultBack is shutting down'); if (this.running.has(id)) throw new BadRequestException('This backup is already running'); return this.run(id); }
   async monitorHealth() {
     const staleHours = Math.max(1, Number.parseInt(String(process.env.BACKUP_STALE_AFTER_HOURS || '26'), 10) || 26);
     const staleBefore = Date.now() - staleHours * 60 * 60 * 1000;
     const jobs = this.store.db.prepare('SELECT id,name FROM backup_jobs WHERE enabled=1').all() as any[];
     for (const job of jobs) { const latest = this.store.db.prepare(`SELECT finished_at as finishedAt FROM backup_runs WHERE job_id=? AND status='success' ORDER BY finished_at DESC LIMIT 1`).get(job.id) as any; if (!latest?.finishedAt || Date.parse(String(latest.finishedAt)) < staleBefore) void this.system.notifyOnce('backup_stale', String(job.id), `VaultBack backup is stale or has never succeeded: ${job.name || job.id}`); }
     for (const target of this.storage.list()) { try { await this.storage.health(this.storage.get(target.id)); } catch (error: any) { void this.system.notifyOnce('storage_failed', target.id, `VaultBack storage target unavailable: ${target.name}. ${String(error?.message || error).slice(0, 240)}`); } }
   }
  async retryRun(runId: string) { const row = this.store.db.prepare('SELECT job_id as jobId,status FROM backup_runs WHERE id=?').get(runId) as any; if (!row?.jobId) throw new BadRequestException('Backup run not found'); if (!['failed', 'retrying'].includes(String(row.status))) throw new BadRequestException('Only a failed backup run can be retried'); return this.runNow(row.jobId); }
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

  private downloadPreparationStatus(job: DownloadPreparation) {
    return { id: job.id, runId: job.runId, filename: job.filename, state: job.state, percent: job.percent, stage: job.stage, message: job.message, error: job.error || '' };
  }
  private publishDownloadPreparation(job: DownloadPreparation) { this.realtime.publishToUser('downloads', job.userId, this.downloadPreparationStatus(job)); }
  private updateDownloadPreparation(job: DownloadPreparation, update: Partial<DownloadPreparation>) { Object.assign(job, update, { updatedAt: Date.now() }); this.publishDownloadPreparation(job); }
  startDownloadPreparation(runId: string, userId: string) {
    this.store.assertEncryptionHealthy();
    const row = this.store.db.prepare('SELECT r.id,r.status,r.filename,r.sha256,r.storage_location as storageLocation,r.storage_folder as storageFolder,COALESCE(r.storage_target_id,j.storage_target_id) as storageTargetId FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id WHERE r.id=?').get(runId) as any;
    if (!row) throw new BadRequestException('Backup run not found');
    if (row.status !== 'success' || !row.filename) throw new BadRequestException('Only completed backups can be downloaded');
    const id = crypto.randomUUID();
    const job: DownloadPreparation = { id, userId, runId, filename: String(row.filename), state: 'preparing', percent: 0, stage: 'checking', message: 'Checking backup availability', updatedAt: Date.now() };
    this.downloadPreparations.set(id, job);
    this.publishDownloadPreparation(job);
    void this.prepareDownload(job, row);
    return this.downloadPreparationStatus(job);
  }
  getDownloadPreparation(id: string, userId: string) {
    const job = this.downloadPreparations.get(id);
    if (!job || job.userId !== userId) throw new BadRequestException('Download preparation not found or expired');
    return this.downloadPreparationStatus(job);
  }
  takePreparedDownload(id: string, userId: string) {
    const job = this.downloadPreparations.get(id);
    if (!job || job.userId !== userId) throw new BadRequestException('Download preparation not found or expired');
    if (job.state !== 'ready' || !job.path) throw new BadRequestException('Backup download is not ready');
    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    this.downloadPreparations.delete(id);
    return { filename: job.filename, path: job.path, cleanup: Boolean(job.cleanup) };
  }
  private async prepareDownload(job: DownloadPreparation, row: any) {
    try {
      this.updateDownloadPreparation(job, { percent: 12, stage: 'connecting', message: 'Connecting to backup storage' });
      const target = this.storage.get(String(row.storageTargetId));
      const progress: StorageDownloadProgress = ({ bytesDownloaded, totalBytes }) => {
        const percent = totalBytes ? Math.min(92, 20 + Math.round((Math.min(bytesDownloaded, totalBytes) / totalBytes) * 72)) : Math.min(90, Math.max(job.percent, 20 + Math.min(70, Math.floor(bytesDownloaded / (1024 * 1024)) + 1)));
        this.updateDownloadPreparation(job, { percent, stage: 'downloading', message: totalBytes ? `Downloading backup · ${percent}%` : 'Downloading backup' });
      };
      this.updateDownloadPreparation(job, { percent: 20, stage: 'downloading', message: 'Downloading backup' });
      const file = await this.storage.download(target, String(row.filename), row.storageLocation ? String(row.storageLocation) : undefined, row.storageFolder ? String(row.storageFolder) : '', progress);
      job.path = file.path; job.cleanup = file.cleanup;
      await this.verifyDownloadedHash(file.path, row.sha256, Boolean(row.sha256));
      this.updateDownloadPreparation(job, { percent: 96, stage: 'finalizing', message: 'Finalizing download' });
      this.updateDownloadPreparation(job, { state: 'ready', percent: 100, stage: 'ready', message: 'Ready to download' });
      job.cleanupTimer = setTimeout(() => {
        const current = this.downloadPreparations.get(job.id);
        if (current !== job) return;
        if (job.cleanup && job.path) { try { fs.rmSync(job.path, { force: true }); fs.rmSync(path.dirname(job.path), { recursive: true, force: true }); } catch {} }
        this.downloadPreparations.delete(job.id);
      }, 10 * 60 * 1000);
      job.cleanupTimer.unref?.();
    } catch (error: any) {
      if (job.path && job.cleanup) { try { fs.rmSync(job.path, { force: true }); fs.rmSync(path.dirname(job.path), { recursive: true, force: true }); } catch {} }
      this.updateDownloadPreparation(job, { state: 'failed', stage: 'failed', percent: Math.min(job.percent, 99), message: 'Download preparation failed', error: String(error?.message || error).slice(0, 500) });
    }
  }
  async downloadRun(runId: string) {
    this.store.assertEncryptionHealthy();
    const row = this.store.db.prepare('SELECT r.id,r.status,r.filename,r.sha256,r.storage_location as storageLocation,r.storage_folder as storageFolder,COALESCE(r.storage_target_id,j.storage_target_id) as storageTargetId FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id WHERE r.id=?').get(runId) as any;
    if (!row) throw new BadRequestException('Backup run not found');
    if (row.status !== 'success' || !row.filename) throw new BadRequestException('Only completed backups can be downloaded');
    const file = await this.storage.download(this.storage.get(String(row.storageTargetId)), String(row.filename), row.storageLocation ? String(row.storageLocation) : undefined, row.storageFolder ? String(row.storageFolder) : '');
    try { await this.verifyDownloadedHash(file.path, row.sha256, Boolean(row.sha256)); return { filename: String(row.filename), ...file }; }
    catch (error) { if (file.cleanup) { try { fs.rmSync(file.path, { force: true }); fs.rmSync(path.dirname(file.path), { recursive: true, force: true }); } catch {} } throw error; }
  }

  private async verifyDownloadedHash(file: string, expectedHash: unknown, requireHash = false) {
    const expected = String(expectedHash || '').trim().replace(/^sha256:/i, '').toLowerCase();
    if (!expected) {
      if (requireHash) throw new BadRequestException('This historical backup has no recorded SHA-256 and cannot be verified');
      return { verified: false, message: 'This historical backup has no recorded SHA-256' };
    }
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new BadRequestException('The recorded backup SHA-256 is invalid');
    const actual = await this.sha256(file);
    if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) throw new BadRequestException('Backup SHA-256 verification failed; the artifact may have changed or been corrupted');
    return { verified: true, sha256: actual };
  }

  private async stageAndVerifyDownload(file: { path: string; cleanup: boolean }, expectedHash: unknown, requireHash = true, cleanupFailures?: string[]) {
    if (file.cleanup) {
      await this.verifyDownloadedHash(file.path, expectedHash, requireHash);
      return file;
    }
    const directory = fs.mkdtempSync(path.join(this.store.dataDir, 'tmp', 'verified-download-'));
    const staged = path.join(directory, path.basename(file.path));
    try {
      await pipeline(
        fs.createReadStream(file.path),
        new TempStorageLimitTransform(this.temporaryFileLimitBytes()),
        fs.createWriteStream(staged, { flags: 'wx', mode: 0o600 })
      );
      await this.verifyDownloadedHash(staged, expectedHash, requireHash);
      return { path: staged, cleanup: true };
    } catch (error: any) {
      try { fs.rmSync(directory, { recursive: true, force: true }); }
      catch (cleanupError: any) {
        const message = `staged download ${path.basename(staged)}: ${String(cleanupError?.message || cleanupError).slice(0, 300)}`;
        cleanupFailures?.push(message);
        if (error instanceof Error) error.message = `${error.message}; cleanup also failed: ${message}`;
        else throw new Error(`${String(error)}; cleanup also failed: ${message}`);
      }
      throw error;
    }
  }

  async restoreRun(runId: string, input: any = {}) {
    this.store.assertEncryptionHealthy();
    const row = this.store.db.prepare('SELECT r.id,r.status,r.filename,r.sha256,r.storage_location as storageLocation,r.storage_folder as storageFolder,j.name as jobName,r.database_connection_id as sourceConnectionId,r.database_scope as databaseScope,r.database_names as databaseNames,r.backup_layout as backupLayout,r.backup_objects as backupObjects,r.expected_objects as expectedObjects,r.storage_target_id as storageTargetId,r.compression,r.backup_encryption as backupEncryption,r.insert_mode as insertMode,r.connection_engine FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id WHERE r.id=?').get(runId) as any;
    if (!row) throw new BadRequestException('Backup run not found');
    if (row.status !== 'success' || !row.filename) throw new BadRequestException('Only completed backups can be restored');
    if (!row.sourceConnectionId || !row.storageTargetId || !row.databaseScope || !row.databaseNames) throw new BadRequestException('This historical backup lacks recorded source, scope, database, or storage metadata and cannot be restored safely');
    const mode = input.mode === 'new' ? 'new' : 'overwrite';
    if (mode === 'overwrite' && input.overwriteConfirmed !== true) throw new BadRequestException('Confirm that the restore may overwrite existing data');
    const destination = this.getConnection(String(input.connectionId || ''));
    const source = this.getConnection(String(row.sourceConnectionId));
    let databases: string[] = []; try { databases = JSON.parse(String(row.databaseNames || '[]')); } catch {}
    databases = [...new Set(databases.filter(name => typeof name === 'string' && name.length > 0))];
    if (!databases.length) throw new BadRequestException('This backup has no verifiable database expectation and cannot be restored safely');
    const expectedObjects = this.parseExpectedObjects(row.expectedObjects, databases);
    let newDatabase = '';
    if (mode === 'new') {
      if (row.databaseScope !== 'selected' || databases.length !== 1) throw new BadRequestException('Restore as a new name is available only for a backup containing one database');
      newDatabase = this.safeDatabaseName(input.databaseName);
      const availableRows = await this.withNativeDatabaseConnection<any>(destination, client => client.query('SHOW DATABASES'));
      const available = new Set((availableRows[0] as any[]).map(item => String(item.Database || Object.values(item)[0] || '')));
      if (available.has(newDatabase) && input.overwriteConfirmed !== true) throw new BadRequestException(`Database ${newDatabase} already exists. Choose another name; recovery rehearsals never overwrite databases.`);
    }
    const tempDir = fs.mkdtempSync(path.join(this.store.dataDir, 'tmp', 'restore-')); let downloaded: { path: string; cleanup: boolean } | undefined;
    try {
      if (!row.sha256) throw new BadRequestException('This historical backup has no recorded SHA-256 and cannot be verified for restore');
      const target = this.storage.get(String(row.storageTargetId)); downloaded = await this.storage.download(target, String(row.filename), row.storageLocation ? String(row.storageLocation) : undefined, row.storageFolder ? String(row.storageFolder) : '');
      downloaded = await this.stageAndVerifyDownload(downloaded, row.sha256, true);
      let sqlFile = downloaded.path; let backupLayout = ['database', 'table'].includes(row.backupLayout) ? row.backupLayout : ''; const compression: 'none' | 'gzip' | 'zip' = ['none', 'gzip', 'zip'].includes(row.compression) ? row.compression : String(row.filename).includes('.sql.gz') ? 'gzip' : String(row.filename).endsWith('.zip') || String(row.filename).endsWith('.zip.enc') ? 'zip' : 'none';
      const encrypted = row.backupEncryption === 'aes-256-gcm' || String(row.filename).endsWith('.enc');
      if (encrypted) { const decrypted = path.join(tempDir, compression === 'zip' ? 'restore.zip' : compression === 'gzip' ? 'restore.sql.gz' : 'restore.sql'); await this.decryptFile(sqlFile, decrypted); sqlFile = decrypted; }
      if (compression === 'gzip') { const expanded = path.join(tempDir, 'restore.sql'); await pipeline(fs.createReadStream(sqlFile), createGunzip(), new TempStorageLimitTransform(this.temporaryFileLimitBytes()), fs.createWriteStream(expanded, { mode: 0o600 })); sqlFile = expanded; }
      const createdByCaller: string[] = Array.isArray(input._createdDatabases) ? input._createdDatabases : [];
      if (mode === 'new') {
        const strictScratch = input.overwriteConfirmed !== true;
        await this.executeMysql(destination, `${strictScratch ? 'CREATE DATABASE' : 'CREATE DATABASE IF NOT EXISTS'} ${this.quoteIdentifier(newDatabase)}`);
        if (strictScratch) createdByCaller.push(newDatabase);
      }
      if (compression === 'zip') {
        if (!backupLayout) backupLayout = this.inferZipLayout(sqlFile, row, databases);
        row.backupLayout = backupLayout;
        const entries = this.validatedZipSqlEntries(sqlFile, row, databases);
        for (const [index, entry] of entries.entries()) {
          const extracted = path.join(tempDir, `restore-${index}.sql`);
          await this.extractZipEntry(sqlFile, entry, extracted);
          const sourceDatabase = this.zipEntryDatabase(entry.name, databases, backupLayout);
          let restoreFile = extracted;
          if (mode === 'new' && backupLayout === 'database') { restoreFile = path.join(tempDir, `restore-renamed-${index}.sql`); await this.rewriteDatabaseName(extracted, sourceDatabase, newDatabase, restoreFile); }
          const destinationDatabase = mode === 'new' ? newDatabase : backupLayout === 'table' ? sourceDatabase : undefined;
          await this.restoreSql(destination, restoreFile, destinationDatabase);
        }
      } else {
        if (!backupLayout) backupLayout = 'single';
        if (mode === 'new') { const rewritten = path.join(tempDir, 'restore-renamed.sql'); await this.rewriteDatabaseName(sqlFile, databases[0], newDatabase, rewritten); sqlFile = rewritten; }
        await this.restoreSql(destination, sqlFile, mode === 'new' ? newDatabase : undefined);
      }
      const restoreDatabases = mode === 'new' ? [newDatabase] : databases;
      const restoreObjects = mode === 'new' ? { [newDatabase]: expectedObjects[databases[0]] } : expectedObjects;
      const restoreVerification = await this.verifyRestore(destination, restoreDatabases, restoreObjects);
      this.store.db.prepare('INSERT INTO verification_reports (id,run_id,kind,status,message,details_json,created_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(), runId, 'restore', restoreVerification.status, restoreVerification.message, JSON.stringify(restoreVerification.details), this.store.now());
      this.store.db.prepare('UPDATE backup_runs SET restore_verification_status=?,restore_verification_message=? WHERE id=?').run(restoreVerification.status, restoreVerification.message, runId);
      if (restoreVerification.status !== 'passed') throw new BadRequestException(`Restore completed but verification failed: ${restoreVerification.message}`);
      void this.system.notify('backup_success', `VaultBack restore completed: ${row.jobName || runId} → ${destination.name}`);
      return { ok: true, mode, destination: destination.name, database: newDatabase || databases.join(', '), verification: restoreVerification, createdDatabases: createdByCaller };
    } finally {
      if (downloaded?.cleanup) { try { fs.rmSync(downloaded.path, { force: true }); fs.rmSync(path.dirname(downloaded.path), { recursive: true, force: true }); } catch {} }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async runConfiguredJob(jobId: string, attempt = 0, _claimHeld = false): Promise<any> {
    const job = this.store.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(jobId) as any;
    const connections = this.jobConnectionLinks(jobId, job);
    const storageTargetIds = this.jobStorageLinks(jobId, job);
    if (connections.length <= 1 && storageTargetIds.length <= 1) return this.run(jobId, attempt);
    const results: Array<{ connectionId: string; storageTargetId: string; ok: boolean; runId?: string; error?: string }> = [];
    for (const connection of connections) {
      for (const storageTargetId of storageTargetIds) {
        try {
          const result = await this.run(jobId, attempt, connection.connectionId, storageTargetId, job.database_scope === 'all' ? undefined : connection.databases, true);
          const ok = result?.ok !== false;
          results.push({ connectionId: connection.connectionId, storageTargetId, ok, runId: result?.id, ...(ok ? {} : { error: String(result?.error || 'Backup pair failed') }) });
        } catch (error: any) {
          results.push({ connectionId: connection.connectionId, storageTargetId, ok: false, error: String(error?.message || error).slice(0, 500) });
        }
      }
    }
    const completed = results.filter(result => result.ok).length;
    const failed = results.length - completed;
    return { ok: failed === 0, completed, failed, results };
  }

  /**
   * Restore one completed artifact into a generated disposable database.
   * This is deliberately separate from the user-facing restore endpoint so a
   * recovery test can never request an overwrite or choose an arbitrary name.
   */
  async restoreRunForRecoveryTest(runId: string, connectionId: string, testDatabaseName: string) {
    const safeName = this.safeDatabaseName(testDatabaseName);
    const destination = this.getConnection(connectionId);
    let result: any;
    const createdDatabases: string[] = [];
    let restoreError: any;
    let cleanupOk = true;
    let cleanupMessage = '';
    try {
      result = await this.restoreRun(runId, {
        connectionId,
        mode: 'new',
        databaseName: safeName,
        overwriteConfirmed: false,
        verifyAfterRestore: true,
        _createdDatabases: createdDatabases
      });
    } catch (error: any) {
      restoreError = error;
    } finally {
      if (createdDatabases.includes(safeName)) {
        try { await this.executeMysql(destination, `DROP DATABASE ${this.quoteIdentifier(safeName)}`); }
        catch (error: any) { cleanupOk = false; cleanupMessage = String(error?.message || error).slice(0, 500); }
      }
    }
    if (restoreError) throw new BadRequestException(`Recovery restore failed: ${String(restoreError?.message || restoreError).slice(0, 700)}${cleanupOk ? '' : `; cleanup also failed for ${safeName}: ${cleanupMessage}`}`);
    return { ...result, cleanupOk, cleanupMessage };
  }

  private async run(jobId: string, attempt = 0, connectionIdOverride?: string, storageTargetIdOverride?: string, databasesOverride?: string[], claimHeld = false): Promise<any> {
    if (this.shuttingDown) throw new Error('VaultBack is shutting down');
    if (!claimHeld) {
      const claimKey = `backup:${jobId}`;
      const token = this.acquireWorkClaim(claimKey, `Backup ${jobId} is already claimed by another process`);
      this.running.add(jobId);
      try { return await this.run(jobId, attempt, connectionIdOverride, storageTargetIdOverride, databasesOverride, true); }
      finally { this.running.delete(jobId); this.releaseWorkClaim(claimKey, token); if (this.queued.delete(jobId)) void this.run(jobId).catch(error => this.logger.error(`Queued backup ${jobId} failed: ${error.message}`)); }
    }
    if (!connectionIdOverride && !storageTargetIdOverride && !databasesOverride) {
      const configured = this.store.db.prepare('SELECT COUNT(*) as count FROM backup_job_connections WHERE job_id=?').get(jobId) as any;
      const configuredStorages = this.store.db.prepare('SELECT COUNT(*) as count FROM backup_job_storages WHERE job_id=?').get(jobId) as any;
      if (Number(configured?.count || 0) > 1 || Number(configuredStorages?.count || 0) > 1) return this.runConfiguredJob(jobId, attempt, true);
    }
    const runId = crypto.randomUUID(); const started = this.store.now(); const previous = this.store.db.prepare("SELECT attempt FROM backup_runs WHERE job_id=? AND status='retrying' ORDER BY started_at DESC LIMIT 1").get(jobId) as any; const runAttempt = attempt || Number(previous?.attempt || 0) + 1; this.store.db.prepare('INSERT INTO backup_runs (id,job_id,status,started_at,attempt) VALUES (?,?,?,?,?)').run(runId, jobId, 'running', started, runAttempt);
    const job = this.store.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(jobId) as any; const startedProcess = this.store.now(); this.liveProcessState.set(runId, { id: runId, jobId, jobName: String(job?.name || jobId), status: 'running', stage: 'preparing', startedAt: startedProcess, updatedAt: startedProcess, logs: [] }); this.addProcessLog(runId, `Backup started for ${job?.name || jobId}`); let tempDir = '';
    try {
      const connection = this.getConnection(connectionIdOverride || job.database_connection_id); const databaseScope: 'all' | 'selected' = job.database_scope === 'all' ? 'all' : 'selected'; const backupLayout = ['database', 'table'].includes(job.backup_layout) ? job.backup_layout : 'single'; const backupObjects = this.backupObjects(job.backup_objects, backupLayout); const insertMode: BackupJob['insertMode'] = job.insert_mode === 'single-row' ? 'single-row' : 'extended'; let databases: string[] = databasesOverride || []; if (!databasesOverride) { try { databases = JSON.parse(String(job.database_names || '[]')); } catch {} } if (databaseScope === 'selected' && !databases.length) databases = connection.databases; if (databaseScope === 'all') databases = (await this.listAvailableDatabases(connection.id)).databases.filter(database => !this.isVirtualDatabase(database)); if (databaseScope === 'selected' && !databases.length) throw new Error('No databases selected for this schedule'); const pitrConfig = this.store.db.prepare('SELECT enabled,base_job_id as baseJobId FROM pitr_sources WHERE connection_id=?').get(connection.id) as any; const recordPitrCoordinates = Boolean(pitrConfig?.enabled && pitrConfig.baseJobId === jobId); if (recordPitrCoordinates && (databaseScope !== 'all' || backupLayout !== 'single' || !backupObjects.views || !backupObjects.routines || !backupObjects.triggers || !backupObjects.events)) throw new Error('The configured PITR baseline must be an all-database single-layout backup with every database object enabled'); const backupConnection: DatabaseConnection = { ...connection, databaseScope, databases, database: databaseScope === 'all' ? '*' : databases[0] || '' }; const sourceObjects = new Map<string, { tables: string[]; views: string[] }>(); for (const database of databases) sourceObjects.set(database, await this.listAvailableTables(connection, database)); const expectedObjects = Object.fromEntries(databases.map(database => { const available = sourceObjects.get(database)!; const names = [...available.tables, ...(backupLayout === 'table' && !backupObjects.views ? [] : available.views)]; return [database, [...new Set(names)].sort()]; })); const target = this.storage.get(storageTargetIdOverride || job.storage_target_id); this.store.db.prepare('UPDATE backup_runs SET storage_target_id=?,database_connection_id=?,database_names=?,database_scope=?,backup_layout=?,backup_objects=?,expected_objects=?,compression=?,backup_encryption=?,insert_mode=?,connection_engine=? WHERE id=?').run(target.id, connection.id, JSON.stringify(databases), databaseScope, backupLayout, JSON.stringify(backupObjects), JSON.stringify(expectedObjects), backupLayout === 'single' && ['none', 'gzip', 'zip'].includes(job.compression) ? job.compression : backupLayout === 'single' ? 'gzip' : 'zip', job.backup_encryption, insertMode, connection.engine, runId); tempDir = fs.mkdtempSync(path.join(this.store.dataDir, 'tmp', 'run-')); const databaseLabel = backupConnection.databaseScope === 'all' ? 'all-databases' : backupConnection.databases.join('-'); const raw = path.join(tempDir, `${safeFilePart(databaseLabel || backupConnection.database)}-${Date.now()}.sql`); const compression = backupLayout === 'single' && ['none', 'gzip', 'zip'].includes(job.compression) ? job.compression : backupLayout === 'single' ? 'gzip' : 'zip'; let artifact = raw;
      this.setProcessStage(runId, 'dumping'); this.addProcessLog(runId, `Dumping ${backupLayout === 'single' ? (databaseScope === 'all' ? 'all visible databases' : `${databases.length} selected database(s)`) : backupLayout === 'database' ? `${databases.length} database file(s)` : 'one SQL file per table'}`);
      if (backupLayout === 'single') { await this.dump(backupConnection, raw, runId, insertMode, recordPitrCoordinates); if (recordPitrCoordinates) { const coordinateAt = this.store.now(); const sample = this.readAt(raw, 0, Math.min(fs.statSync(raw).size, 1024 * 1024)).toString('utf8'); const coordinates = parseDumpBinlogCoordinates(sample); if (!coordinates) throw new Error('The baseline dump did not include a verifiable binary-log coordinate'); this.store.db.prepare('UPDATE backup_runs SET pitr_log_file=?,pitr_log_position=?,pitr_coordinate_at=? WHERE id=?').run(coordinates.file, coordinates.position, coordinateAt, runId); } if (compression === 'gzip') { this.setProcessStage(runId, 'compressing'); this.addProcessLog(runId, 'Compressing SQL archive'); artifact = `${raw}.gz`; await pipeline(fs.createReadStream(raw), createGzip({ level: 6 }), fs.createWriteStream(artifact)); fs.rmSync(raw); } else if (compression === 'zip') { this.setProcessStage(runId, 'compressing'); this.addProcessLog(runId, 'Creating ZIP archive'); artifact = `${raw}.zip`; const zipEntries = this.addBackupManifest([{ name: 'backup.sql', path: raw }], tempDir, backupLayout, databaseScope, databases); await this.writeZip(zipEntries, artifact); fs.rmSync(raw); } } else { const entries: Array<{ name: string; path: string }> = []; if (backupLayout === 'database') { for (const database of databases) { const output = path.join(tempDir, `${safeFilePart(database)}.sql`); await this.dumpDatabase(backupConnection, database, output, runId, insertMode); entries.push({ name: `${safeFilePart(database)}/${safeFilePart(database)}.sql`, path: output }); } } else { for (const database of databases) { const available = sourceObjects.get(database)!; const tables = available.tables; const databasePart = safeFilePart(database); if (available.views.length && !backupObjects.views) this.addProcessLog(runId, `Skipping ${available.views.length} view(s) in ${database} because view backup is disabled`); if (!backupObjects.triggers) this.addProcessLog(runId, `Skipping table triggers in ${database} because trigger backup is disabled`); if (!tables.length) this.addProcessLog(runId, `No base tables found in ${database}`); for (const table of tables) { const tablePart = safeFilePart(table); const output = path.join(tempDir, `${databasePart}-${tablePart}.sql`); await this.dumpTable(backupConnection, database, table, output, runId, backupObjects.triggers, insertMode); entries.push({ name: `${databasePart}/${tablePart}.sql`, path: output }); } if (backupObjects.views || backupObjects.routines || backupObjects.events) { const objectsOutput = path.join(tempDir, `${databasePart}-objects.sql`); await this.dumpDatabaseObjects(backupConnection, database, available, backupObjects, objectsOutput, runId); if (this.containsDatabaseObjectSql(objectsOutput)) { entries.push({ name: `${databasePart}/_database-objects.sql`, path: objectsOutput }); this.addProcessLog(runId, `Included database objects for ${database}`); } else { fs.rmSync(objectsOutput, { force: true }); } } } } if (!entries.length) throw new Error('No databases or tables were available for the selected backup scope'); this.setProcessStage(runId, 'compressing'); this.addProcessLog(runId, `Creating ZIP archive with ${entries.length} SQL file(s)`); artifact = path.join(tempDir, `${safeFilePart(databaseLabel)}.zip`); await this.writeZip(this.addBackupManifest(entries, tempDir, backupLayout, databaseScope, databases), artifact); }
      if (job.backup_encryption === 'aes-256-gcm') { this.setProcessStage(runId, 'encrypting'); this.addProcessLog(runId, 'Encrypting backup archive'); const encrypted = `${artifact}.enc`; await this.encryptFile(artifact, encrypted); fs.rmSync(artifact); artifact = encrypted; }
      this.setProcessStage(runId, 'verifying'); this.addProcessLog(runId, 'Verifying archive contents');
      const filename = `${safeFilePart(job.filename_prefix)}-${new Date().toISOString().replace(/[:.]/g, '-')}.${compression === 'gzip' ? 'sql.gz' : compression === 'zip' ? 'zip' : 'sql'}${job.backup_encryption === 'aes-256-gcm' ? '.enc' : ''}`;
      const storageFolder = `schedule-${safeFilePart(jobId)}-${safeFilePart(connection.id)}`;
      const verification = await this.verifyArtifact(artifact, compression, job.backup_encryption === 'aes-256-gcm', tempDir);
      const stats = fs.statSync(artifact); const hash = await this.sha256(artifact);
      this.setProcessStage(runId, 'uploading'); this.addProcessLog(runId, `Uploading ${filename}`);
      const uploaded = await this.storage.upload(target, artifact, filename, storageFolder);
      this.setProcessStage(runId, 'rotating'); this.addProcessLog(runId, 'Applying retention rotation');
      const removedBackups = await this.storage.rotate(target, safeFilePart(job.filename_prefix), Number(job.retention_count), storageFolder);
      this.expireRotatedRuns(jobId, target.id, storageFolder, removedBackups);
      this.addProcessLog(runId, removedBackups.length ? `Removed ${removedBackups.length} older backup${removedBackups.length === 1 ? '' : 's'}` : 'No older backups needed removal');
      const finished = this.store.now(); this.store.db.prepare('UPDATE backup_runs SET status=?,finished_at=?,filename=?,storage_location=?,storage_folder=?,size_bytes=?,sha256=?,verification_status=?,verification_message=? WHERE id=?').run('success', finished, filename, uploaded.location, storageFolder, stats.size, hash, verification.status, verification.message, runId); this.store.db.prepare('UPDATE backup_jobs SET last_run_at=? WHERE id=?').run(finished, jobId); if (recordPitrCoordinates) { try { this.store.db.prepare("UPDATE pitr_sources SET checkpoint_json='{}',gap_status='unknown',last_continuous_at=NULL,next_capture_at=?,message='New PITR baseline recorded; capture its binlogs to establish continuous coverage' WHERE connection_id=? AND enabled=1").run(finished, connection.id); } catch (error: any) { this.logger.warn(`Could not reset PITR coverage for new baseline ${runId}: ${String(error?.message || error).slice(0, 240)}`); } } void this.system.notify('backup_success', `VaultBack backup succeeded: ${job.name || jobId} -> ${filename}`); return { ok: true, id: runId, filename, sizeBytes: stats.size, sha256: hash, verification };
    } catch (error: any) { const message = String(error.message || error).slice(0, 1000); this.logger.error(`Backup ${jobId} failed: ${message}`); const retry = this.store.db.prepare('SELECT retry_count as retryCount,retry_delay_seconds as retryDelaySeconds FROM backup_jobs WHERE id=?').get(jobId) as any; const attempt = Number((this.store.db.prepare('SELECT attempt FROM backup_runs WHERE id=?').get(runId) as any)?.attempt || 1); const retryAvailable = attempt <= Number(retry?.retryCount || 0); this.setProcessStage(runId, 'failed', 'failed', retryAvailable ? `${message} — retry ${attempt}/${retry.retryCount} scheduled` : message); this.store.db.prepare('UPDATE backup_runs SET status=?,finished_at=?,error_message=?,verification_status=?,attempt=? WHERE id=?').run(retryAvailable ? 'retrying' : 'failed', this.store.now(), message, 'failed', attempt, runId); if (retryAvailable) { void this.system.notify('backup_retry', `VaultBack backup failed; retry ${attempt}/${retry.retryCount} scheduled: ${jobId}`); const delay = Math.max(30, Number(retry.retryDelaySeconds || 300)) * 1000; const timer = setTimeout(() => { void this.run(jobId).catch(retryError => this.logger.error(`Backup retry ${jobId} failed: ${retryError.message}`)); }, delay); timer.unref?.(); return { ok: false, retryScheduled: true, retryInSeconds: delay / 1000 }; } void this.system.notify('backup_failed', `VaultBack backup failed: ${jobId}\n${message}`); throw error; } finally { const process = this.liveProcessState.get(runId); if (process?.status === 'running') this.setProcessStage(runId, 'completed', 'success', 'Backup process finished'); if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); }
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
  private expireRotatedRuns(jobId: string, storageTargetId: string, storageFolder: string, filenames: string[]) {
    if (!filenames.length) return;
    const placeholders = filenames.map(() => '?').join(',');
    this.store.db.prepare(`UPDATE backup_runs SET status='expired',verification_status='expired',verification_message='Backup removed by retention rotation' WHERE job_id=? AND status='success' AND COALESCE(storage_target_id, (SELECT storage_target_id FROM backup_jobs WHERE id=?))=? AND COALESCE(storage_folder,'')=? AND filename IN (${placeholders})`).run(jobId, jobId, storageTargetId, storageFolder, ...filenames);
  }
  private readAt(file: string, offset: number, length: number) { const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(length); try { let read = 0; while (read < length) { const count = fs.readSync(fd, buffer, read, length - read, offset + read); if (!count) break; read += count; } return buffer.subarray(0, read); } finally { fs.closeSync(fd); } }
  private readZipEntries(file: string): ZipEntry[] {
    const size = fs.statSync(file).size; const tailLength = Math.min(size, 22 + 0xffff); const tail = this.readAt(file, size - tailLength, tailLength); let end = -1; for (let index = tail.length - 22; index >= 0; index--) if (tail.readUInt32LE(index) === 0x06054b50) { end = index; break; } if (end < 0) throw new Error('ZIP archive directory is missing');
    const count = tail.readUInt16LE(end + 10); const centralSize = tail.readUInt32LE(end + 12); const centralOffset = tail.readUInt32LE(end + 16); if (count > 100000 || centralSize > 32 * 1024 * 1024 || centralOffset + centralSize > size) throw new Error('ZIP archive is too large or invalid'); const directory = this.readAt(file, centralOffset, centralSize); const entries: ZipEntry[] = []; let cursor = 0;
    const seenNames = new Set<string>();
    for (let index = 0; index < count; index++) { if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP archive entry is invalid'); const flags = directory.readUInt16LE(cursor + 8); const method = directory.readUInt16LE(cursor + 10); const compressedSize = directory.readUInt32LE(cursor + 20); const uncompressedSize = directory.readUInt32LE(cursor + 24); const nameLength = directory.readUInt16LE(cursor + 28); const extraLength = directory.readUInt16LE(cursor + 30); const commentLength = directory.readUInt16LE(cursor + 32); const localOffset = directory.readUInt32LE(cursor + 42); const entryEnd = cursor + 46 + nameLength + extraLength + commentLength; if (entryEnd > directory.length || localOffset + 30 > centralOffset) throw new Error('ZIP archive entry bounds are invalid'); const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'utf8'); if (!name || name.includes('\\') || name.includes('\0') || name.endsWith('/') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => part === '..' || part === '.') || (flags & 1) !== 0 || ![0, 8].includes(method) || seenNames.has(name)) throw new Error('ZIP archive contains an unsafe, duplicate, or unsupported entry'); const local = this.readAt(file, localOffset, 30); if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP local entry is invalid'); const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28); if (dataOffset + compressedSize > centralOffset) throw new Error('ZIP entry data extends outside the archive data region'); seenNames.add(name); entries.push({ name, method, compressedSize, uncompressedSize, localOffset }); cursor = entryEnd; }
    return entries;
  }
  private zipEntryBuffer(file: string, entry: ZipEntry) {
    if (entry.uncompressedSize > 1024 * 1024 || entry.compressedSize > 1024 * 1024) throw new BadRequestException('ZIP manifest is too large');
    const local = this.readAt(file, entry.localOffset, 30);
    if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) throw new BadRequestException('ZIP local entry is invalid');
    const offset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const compressed = this.readAt(file, offset, entry.compressedSize);
    const output = entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: 1024 * 1024 }) : compressed;
    if (output.length !== entry.uncompressedSize) throw new BadRequestException('ZIP manifest length does not match its directory entry');
    return output;
  }
  private inferZipLayout(file: string, row: any, databases: string[]) {
    const entries = this.readZipEntries(file);
    const manifests = entries.filter(entry => entry.name === 'vaultback-manifest.json');
    if (manifests.length) {
      if (manifests.length !== 1) throw new BadRequestException('ZIP archive contains duplicate VaultBack manifests');
      let manifest: any;
      try { manifest = JSON.parse(this.zipEntryBuffer(file, manifests[0]).toString('utf8')); }
      catch { throw new BadRequestException('ZIP backup manifest is invalid'); }
      if (manifest?.formatVersion !== 1 || !['single', 'database', 'table'].includes(manifest.layout) || manifest.databaseScope !== row.databaseScope || JSON.stringify([...new Set(manifest.databases || [])].sort()) !== JSON.stringify([...databases].sort())) throw new BadRequestException('ZIP backup manifest cannot verify the recorded run layout and databases');
      return String(manifest.layout);
    }
    const sqlEntries = entries.filter(entry => entry.name.toLowerCase().endsWith('.sql'));
    if (sqlEntries.length === 1 && sqlEntries[0].name === 'backup.sql') return 'single';
    let inferred: 'database' | 'table' | null = null;
    for (const entry of sqlEntries) {
      const [database, filename, ...extra] = entry.name.split('/');
      if (!database || !filename || extra.length || !databases.some(name => safeFilePart(name) === database)) throw new BadRequestException('Legacy ZIP entries cannot be mapped to recorded databases');
      const current = filename === `${database}.sql` ? 'database' : 'table';
      if (inferred && inferred !== current) throw new BadRequestException('Legacy ZIP layout is ambiguous and cannot be restored safely');
      inferred = current;
    }
    if (!inferred) throw new BadRequestException('ZIP backup layout cannot be verified');
    return inferred;
  }
  private validatedZipSqlEntries(file: string, row: any, databases: string[]) {
    const archiveEntries = this.readZipEntries(file);
    const manifestEntries = archiveEntries.filter(entry => entry.name === 'vaultback-manifest.json');
    if (manifestEntries.length > 1) throw new BadRequestException('ZIP archive contains duplicate VaultBack manifests');
    const sqlEntries = archiveEntries.filter(entry => entry.name.toLowerCase().endsWith('.sql'));
    if (!sqlEntries.length) throw new BadRequestException('ZIP backup does not contain SQL files');
    const backupLayout = ['database', 'table'].includes(row.backupLayout) ? row.backupLayout : 'single';
    if (manifestEntries.length) {
      let manifest: any;
      try { manifest = JSON.parse(this.zipEntryBuffer(file, manifestEntries[0]).toString('utf8')); }
      catch { throw new BadRequestException('ZIP backup manifest is invalid'); }
      if (manifest?.formatVersion !== 1 || manifest?.layout !== backupLayout || manifest?.databaseScope !== row.databaseScope || !Array.isArray(manifest.databases) || !Array.isArray(manifest.sqlEntries)) throw new BadRequestException('ZIP backup manifest does not match the recorded run configuration');
      const manifestDatabases = [...new Set(manifest.databases.map((value: unknown) => String(value)))].sort();
      if (JSON.stringify(manifestDatabases) !== JSON.stringify([...databases].sort())) throw new BadRequestException('ZIP backup manifest database list does not match the recorded run');
      const manifestSql = [...new Set(manifest.sqlEntries.map((value: unknown) => String(value)))].sort();
      const actualSql = sqlEntries.map(entry => entry.name).sort();
      if (JSON.stringify(manifestSql) !== JSON.stringify(actualSql)) throw new BadRequestException('ZIP backup SQL entries do not match the manifest');
      const expectedEntries = [...manifestSql, 'vaultback-manifest.json'].sort();
      const actualEntries = archiveEntries.map(entry => entry.name).sort();
      if (JSON.stringify(expectedEntries) !== JSON.stringify(actualEntries)) throw new BadRequestException('ZIP archive contains entries not listed in the manifest');
    } else if (archiveEntries.some(entry => !entry.name.toLowerCase().endsWith('.sql'))) {
      throw new BadRequestException('Legacy ZIP backup contains an entry outside its SQL file set');
    }
    if (backupLayout === 'single' && (sqlEntries.length !== 1 || sqlEntries[0].name !== 'backup.sql')) throw new BadRequestException('Single-layout ZIP backup must contain only backup.sql');
    if (backupLayout !== 'single') {
      const prefixes = new Map<string, string>();
      for (const database of databases) {
        const part = safeFilePart(database);
        if (prefixes.has(part) && prefixes.get(part) !== database) throw new BadRequestException('ZIP database prefixes are ambiguous in the recorded run');
        prefixes.set(part, database);
      }
      for (const entry of sqlEntries) {
        const databasePart = entry.name.split('/')[0];
        if (!prefixes.has(databasePart)) throw new BadRequestException(`ZIP entry ${entry.name} is outside the recorded database list`);
        if (entry.name.split('/').length !== 2 || !entry.name.endsWith('.sql')) throw new BadRequestException(`ZIP entry ${entry.name} has an unexpected path`);
      }
    }
    return sqlEntries;
  }
  private zipEntryDatabase(name: string, databases: string[], backupLayout: string) {
    if (backupLayout === 'single') return databases[0];
    const part = name.split('/')[0];
    const matches = databases.filter(database => safeFilePart(database) === part);
    if (matches.length !== 1) throw new BadRequestException(`ZIP entry ${name} does not map to exactly one recorded database`);
    return matches[0];
  }
  private addBackupManifest(entries: Array<{ name: string; path: string }>, tempDir: string, layout: string, databaseScope: string, databases: string[]) {
    const filename = path.join(tempDir, 'vaultback-manifest.json');
    fs.writeFileSync(filename, JSON.stringify({ formatVersion: 1, layout, databaseScope, databases, sqlEntries: entries.map(entry => entry.name) }, null, 2), { encoding: 'utf8', mode: 0o600 });
    return [...entries, { name: 'vaultback-manifest.json', path: filename }];
  }
  private async extractZipEntry(file: string, entry: ZipEntry, output: string) { const limit = this.temporaryFileLimitBytes(); if (entry.uncompressedSize > limit) throw new BadRequestException('ZIP entry exceeds available temporary storage'); const local = this.readAt(file, entry.localOffset, 30); if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP local entry is invalid'); const dataOffset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28); if (dataOffset + entry.compressedSize > fs.statSync(file).size) throw new BadRequestException('ZIP entry data extends beyond the archive'); const source = fs.createReadStream(file, { start: dataOffset, end: dataOffset + entry.compressedSize - 1 }); await pipeline(source, entry.method === 8 ? createInflateRaw() : new PassThrough(), new TempStorageLimitTransform(limit), fs.createWriteStream(output, { mode: 0o600 })); }
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
    await pipeline(fs.createReadStream(input, { start: 18, end: size - 17 }), decipher, new TempStorageLimitTransform(this.temporaryFileLimitBytes()), fs.createWriteStream(output, { mode: 0o600 }));
  }

  private async verifyArtifact(file: string, compression: 'none' | 'gzip' | 'zip', encrypted: boolean, tempDir: string) {
    let source = file; let intermediate = '';
    try {
      if (encrypted) { intermediate = path.join(tempDir, 'verified-artifact'); await this.decryptFile(source, intermediate); source = intermediate; }
      const preview = compression === 'gzip' ? await (async () => { const sqlFile = path.join(tempDir, 'verified.sql'); await pipeline(fs.createReadStream(source), createGunzip(), new TempStorageLimitTransform(this.temporaryFileLimitBytes()), fs.createWriteStream(sqlFile, { mode: 0o600 })); return this.readPrefix(sqlFile, 32768); })() : compression === 'zip' ? await this.verifyZip(source, tempDir) : this.readPrefix(source, 32768);
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
  // These schemas expose server metadata rather than user tables. Splitting
  // them into table files makes MariaDB try to serialize internal views such
  // as information_schema.* and fail with the misleading ds_view error.
  private isVirtualDatabase(database: string) { return new Set(['information_schema', 'performance_schema', 'sys', 'mysql']).has(String(database).trim().toLowerCase()); }
  private quoteIdentifier(value: string) { return `\`${value.replace(/`/g, '``')}\``; }
  private rewriteDatabaseName(input: string, source: string, target: string, output: string) { return this.rewritePitrSqlFile(input, { [source]: target }, output); }
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
  resolveBinlogBinary(engine: string): string {
    const configured = engine === 'mysql' ? String(process.env.MYSQL_BINLOG_PATH || '').trim() : '';
    if (configured) {
      const candidate = path.resolve(process.cwd(), configured);
      const expectedName = process.platform === 'win32' ? 'mysqlbinlog.exe' : 'mysqlbinlog';
      if (path.basename(candidate).toLowerCase() !== expectedName.toLowerCase() || !this.executableAvailable(candidate)) {
        throw new BadRequestException(`MYSQL_BINLOG_PATH must point to an existing ${expectedName} executable`);
      }
      return candidate;
    }
    const engineFolder = engine === 'mariadb' ? 'mariadb' : 'mysql';
    const names = process.platform === 'win32' ? ['mysqlbinlog.exe', 'mariadb-binlog.exe', 'mysqlbinlog', 'mariadb-binlog'] : ['mysqlbinlog', 'mariadb-binlog'];
    const platformFolder = `${process.platform}-${process.arch}`; const toolsRoot = path.join(process.cwd(), 'tools');
    const roots = [path.join(toolsRoot, engineFolder, platformFolder, 'bin'), path.join(toolsRoot, engineFolder, 'bin'), ...(engine === 'mysql' ? [path.join(toolsRoot, 'mariadb', platformFolder, 'bin'), path.join(toolsRoot, 'mariadb', 'bin')] : [])];
    for (const root of roots) for (const name of names) { const candidate = path.join(root, name); if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; }
    return path.join(toolsRoot, engineFolder, platformFolder, 'bin', process.platform === 'win32' ? 'mysqlbinlog.exe' : 'mysqlbinlog');
  }
  private isNativeMysqlBinlog(engine: string, binary: string) {
    if (engine !== 'mysql') return false;
    const configured = String(process.env.MYSQL_BINLOG_PATH || '').trim();
    if (configured && path.resolve(process.cwd(), configured) === path.resolve(binary)) return true;
    return isWithin(path.resolve(process.cwd(), 'tools', 'mysql'), path.resolve(binary));
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
  private async verifyRestore(connection: DatabaseConnection, databases: string[], expectedObjects: Record<string, string[]>) {
    try {
      if (!Array.isArray(databases) || !databases.length || databases.some(name => !String(name || '').trim())) throw new Error('Restore verification has no complete database expectation');
      if (!expectedObjects || typeof expectedObjects !== 'object' || databases.some(database => !Array.isArray(expectedObjects[database]))) throw new Error('Restore verification has no complete table-object expectation');
      const details: Array<{ database: string; tables: number; expectedObjects: string[]; missingObjects: string[] }> = [];
      await this.withNativeDatabaseConnection(connection, async client => {
        const [availableRows] = await client.query('SHOW DATABASES');
        const available = new Set((availableRows as any[]).map(row => String(row.Database || Object.values(row)[0] || '')));
        for (const database of databases.filter(Boolean)) {
          if (!available.has(database)) throw new Error(`Database ${database} was not found after restore`);
          const [rows] = await client.query('SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [database]);
          const availableObjects = new Set((rows as any[]).map(row => String(row.tableName ?? row.TABLE_NAME ?? '')));
          const expected = [...new Set(expectedObjects[database].map(String))];
          const missingObjects = expected.filter(name => !availableObjects.has(name));
          details.push({ database, tables: availableObjects.size, expectedObjects: expected, missingObjects });
          if (missingObjects.length) throw new Error(`Database ${database} is missing expected tables or views: ${missingObjects.slice(0, 10).join(', ')}`);
        }
      });
      if (!details.length) throw new Error('No expected database was checked after restore');
      return { status: 'passed', message: `Verified ${details.length} database${details.length === 1 ? '' : 's'} and ${details.reduce((total, item) => total + item.expectedObjects.length, 0)} expected table or view object(s)`, details };
    } catch (error: any) { return { status: 'failed', message: String(error?.message || error).slice(0, 500), details: {} }; }
  }
  private parseExpectedObjects(value: unknown, databases: string[]): Record<string, string[]> {
    let parsed: any;
    try { parsed = JSON.parse(String(value || '')); } catch {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadRequestException('This historical backup has no verifiable table-object expectation');
    const keys = Object.keys(parsed);
    if (keys.length !== databases.length || databases.some(database => !Object.prototype.hasOwnProperty.call(parsed, database))) throw new BadRequestException('The backup table-object expectation does not match its recorded database list');
    const result = Object.create(null) as Record<string, string[]>;
    for (const database of databases) {
      const names = parsed[database];
      if (!Array.isArray(names) || names.some((name: unknown) => typeof name !== 'string' || !name.trim())) throw new BadRequestException(`The backup has no valid table-object expectation for ${database}`);
      result[database] = [...new Set(names.map((name: string) => name))];
    }
    return result;
  }
  async inspectPitr(connectionId: string) {
    const connection = this.getConnection(connectionId);
    return this.withNativeDatabaseConnection(connection, async client => {
      const [variables] = await client.query("SHOW VARIABLES WHERE Variable_name IN ('log_bin','binlog_format','gtid_mode','gtid_binlog_pos','gtid_executed')");
      const values: Record<string, string> = {};
      for (const row of variables as any[]) values[String(row.Variable_name || row.variable_name)] = String(row.Value ?? row.value ?? '');
      let logs: any[] = [];
      try { const [rows] = await client.query('SHOW BINARY LOGS'); logs = rows as any[]; } catch { logs = []; }
      const enabled = /^(ON|1|TRUE)$/i.test(values.log_bin || '');
      return { status: enabled ? 'ready' : 'disabled', message: enabled ? 'Binary logging is enabled; retain and monitor binlog continuity before relying on point-in-time recovery.' : 'Binary logging is disabled. Point-in-time recovery is unavailable until it is enabled and retained safely.', binaryLogging: enabled, binlogFormat: values.binlog_format || null, gtid: values.gtid_executed || values.gtid_binlog_pos || null, logCount: logs.length, earliestLog: logs[0]?.Log_name || null, latestLog: logs[logs.length - 1]?.Log_name || null };
    });
  }
  async capturePitr(connectionId: string, storageTargetId: string, scheduled = false) {
    if (this.pitrCapturing.has(connectionId)) throw new BadRequestException('A PITR capture is already running for this source');
    const claimKey = `pitr:${connectionId}`;
    const claimToken = this.acquireWorkClaim(claimKey, 'A PITR capture is already running for this source in another application process');
    this.pitrCapturing.add(connectionId);
    const captureId = crypto.randomUUID();
    let tempDir = '';
    try {
      const connection = this.getConnection(connectionId);
      const target = this.storage.get(storageTargetId);
      const sourceState = this.store.db.prepare('SELECT enabled,base_job_id as baseJobId,capture_interval_minutes as interval FROM pitr_sources WHERE connection_id=?').get(connectionId) as any;
      if (scheduled && (!sourceState?.enabled || !sourceState.baseJobId)) throw new BadRequestException('Scheduled PITR capture is not configured for this source');
      const baseline = scheduled ? this.store.db.prepare("SELECT id,pitr_log_file as logFile,pitr_log_position as logPosition,expected_objects as expectedObjects,database_names as databaseNames FROM backup_runs WHERE job_id=? AND database_connection_id=? AND status='success' AND pitr_log_file IS NOT NULL AND pitr_log_position IS NOT NULL ORDER BY COALESCE(finished_at,started_at) DESC LIMIT 1").get(sourceState.baseJobId, connectionId) as any : null;
      const inspection = await this.inspectPitr(connectionId);
      if (!inspection.binaryLogging) throw new BadRequestException('Binary logging is disabled. Enable and retain binary logs before starting PITR capture.');
      if (!inspection.latestLog) throw new BadRequestException('The database reported no available binary log files.');
      const serverLogs = await this.withNativeDatabaseConnection(connection, async client => {
        const [rows] = await client.query('SHOW BINARY LOGS');
        return (rows as any[]).map(row => ({ name: String(row.Log_name || row.log_name || ''), size: Number(row.File_size || row.file_size || 0) })).filter(item => item.name);
      });
      if (!serverLogs.length) throw new BadRequestException('The database reported no available binary log files.');
      let logs = serverLogs.map(item => item.name);
      if (scheduled) {
        if (!baseline) {
          this.recordPitrCaptureState(connectionId, storageTargetId, sourceState, 'unknown', 'Waiting for a successful PITR baseline backup with binlog coordinates', null);
          return { ok: false, captured: 0, status: 'waiting_for_baseline', message: 'Run the configured all-database schedule to create a baseline with binlog coordinates.' };
        }
        try { this.parseExpectedObjects(baseline.expectedObjects, this.parseDatabaseList(baseline.databaseNames)); }
        catch { this.recordPitrCaptureState(connectionId, storageTargetId, sourceState, 'unknown', 'The latest PITR baseline has no verifiable table-object expectation', null); return { ok: false, captured: 0, status: 'waiting_for_baseline', message: 'Run the configured schedule again to record expected database objects before PITR capture.' }; }
        const start = logs.indexOf(String(baseline.logFile));
        if (start < 0) {
          this.recordPitrCaptureState(connectionId, storageTargetId, sourceState, 'gap', `Baseline log ${baseline.logFile} has been purged from the source before it was captured`, null);
          throw new BadRequestException(`PITR coverage has a gap: baseline log ${baseline.logFile} is no longer available`);
        }
        logs = logs.slice(start);
        const namesWithArtifacts = new Set((this.store.db.prepare("SELECT DISTINCT binlog_name as name FROM pitr_artifacts WHERE connection_id=? AND storage_target_id=? AND capture_kind='scheduled' AND status='captured'").all(connectionId, storageTargetId) as any[]).map(item => String(item.name)));
        const newest = logs[logs.length - 1];
        logs = logs.filter(name => !namesWithArtifacts.has(name) || name === newest);
      }
      if (!logs.length) throw new BadRequestException('No binary logs are available to capture');
      tempDir = fs.mkdtempSync(path.join(this.store.dataDir, 'tmp', `pitr-${captureId}-`));
      const resultPrefix = path.join(tempDir, 'pitr-');
      const binary = this.resolveBinlogBinary(connection.engine);
      const transportArgs = pitrBinlogTransportOptions(connection.engine, this.isNativeMysqlBinlog(connection.engine, binary), connection.ssl);
      const args = [...this.clientToolArgs(binary), '--read-from-remote-server', '--raw', `--host=${connection.host}`, `--port=${connection.port}`, `--user=${connection.username}`, `--result-file=${resultPrefix}`, ...transportArgs, ...logs];
      const env = { ...process.env }; if (connection.password) env.MYSQL_PWD = connection.password; else delete env.MYSQL_PWD;
      await new Promise<void>((resolve, reject) => {
        let stderr = ''; let child: ReturnType<typeof spawn>;
        try { child = spawn(binary, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); }
        catch (error: any) { reject(new BadRequestException(this.clientStartMessage(binary, error))); return; }
        child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', error => reject(new BadRequestException(this.clientStartMessage(binary, error))));
        child.on('close', code => code === 0 ? resolve() : reject(new BadRequestException(`${binary} binlog capture failed with code ${code}: ${stderr.slice(0, 1000)}`)));
      });
      const files = fs.readdirSync(tempDir, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).filter(file => logs.includes(file.startsWith('pitr-') ? file.slice(5) : file));
      if (!files.length) throw new BadRequestException('The binlog client completed without producing any requested raw binary-log files.');
      const capturedAt = this.store.now();
      const folder = `pitr-${safeFilePart(connectionId)}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const artifacts: any[] = [];
      for (const file of files) {
        const source = path.join(tempDir, file); const binlogName = file.startsWith('pitr-') ? file.slice(5) : file;
        const uploaded = await this.storage.upload(target, source, binlogName, folder);
        const sizeBytes = fs.statSync(source).size; const sha256 = await this.sha256(source); const id = crypto.randomUUID();
        const serverLog = serverLogs.find(item => item.name === binlogName);
        this.store.db.prepare('INSERT INTO pitr_artifacts (id,connection_id,storage_target_id,binlog_name,storage_location,storage_folder,size_bytes,sha256,captured_at,status,message,capture_id,capture_kind,log_position,log_size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, connectionId, storageTargetId, binlogName, uploaded.location, folder, sizeBytes, sha256, capturedAt, 'pending', 'Capture is incomplete until all files in the batch are uploaded', captureId, scheduled ? 'scheduled' : 'manual', sizeBytes, serverLog?.size || sizeBytes);
        artifacts.push({ id, binlogName, sizeBytes, sha256, storageLocation: uploaded.location, storageFolder: folder });
      }
      this.store.db.prepare('UPDATE pitr_artifacts SET status=?,message=? WHERE capture_id=? AND status=?').run('captured', 'Raw binary log uploaded and checksum recorded', captureId, 'pending');
      let continuous = false;
      let gapMessage = 'Manual capture artifacts do not establish continuous PITR coverage';
      if (scheduled && baseline) {
        const visible = serverLogs.map(item => item.name);
        const expected = visible.slice(visible.indexOf(String(baseline.logFile)));
        const gapNames = findBinlogSequenceGaps(expected);
        const covered = new Set((this.store.db.prepare("SELECT DISTINCT binlog_name as name FROM pitr_artifacts WHERE connection_id=? AND storage_target_id=? AND capture_kind='scheduled' AND status='captured'").all(connectionId, storageTargetId) as any[]).map(item => String(item.name)));
        const missing = expected.filter(name => !covered.has(name));
        continuous = !gapNames.length && !missing.length;
        gapMessage = continuous ? `Continuous binary-log files captured through ${expected[expected.length - 1]}` : gapNames.length ? `Binary-log sequence gap detected: ${gapNames.join(', ')}` : `Binary-log coverage is missing ${missing.join(', ')}`;
        const interval = Math.max(1, Math.min(1440, Number(sourceState.interval || 15)));
        const nextCapture = new Date(Date.now() + interval * 60000).toISOString();
        this.store.db.prepare('UPDATE pitr_sources SET storage_target_id=?,last_scan_at=?,last_capture_at=?,next_capture_at=?,binlog_status=?,earliest_binlog_at=?,latest_binlog_at=?,checkpoint_json=?,gap_status=?,last_continuous_at=?,message=? WHERE connection_id=?').run(storageTargetId, capturedAt, capturedAt, nextCapture, 'captured', visible[0] || null, visible[visible.length - 1] || null, JSON.stringify({ baselineRunId: baseline.id, baselineFile: baseline.logFile, baselinePosition: baseline.logPosition, visibleLogs: visible, capturedAt }), continuous ? 'continuous' : 'gap', continuous ? capturedAt : null, gapMessage, connectionId);
      } else {
        this.store.db.prepare("INSERT OR IGNORE INTO pitr_sources (connection_id,storage_target_id,enabled,capture_interval_minutes,last_scan_at,last_capture_at,binlog_status,earliest_binlog_at,latest_binlog_at,checkpoint_json,gap_status,message) VALUES (?,?,0,15,?,?,?,?,?,?, 'unknown',?)").run(connectionId, storageTargetId, capturedAt, capturedAt, 'captured', serverLogs[0]?.name || null, serverLogs[serverLogs.length - 1]?.name || null, JSON.stringify({ capturedLogs: serverLogs.map(item => item.name), capturedAt }), gapMessage);
        this.store.db.prepare("UPDATE pitr_sources SET storage_target_id=?,last_scan_at=?,last_capture_at=?,binlog_status='captured',earliest_binlog_at=?,latest_binlog_at=?,checkpoint_json=?,message=? WHERE connection_id=? AND enabled=0").run(storageTargetId, capturedAt, capturedAt, serverLogs[0]?.name || null, serverLogs[serverLogs.length - 1]?.name || null, JSON.stringify({ capturedLogs: serverLogs.map(item => item.name), capturedAt }), gapMessage, connectionId);
      }
      return { ok: true, connectionId, storageTargetId, captureId, captured: artifacts.length, artifacts, status: scheduled ? continuous ? 'continuous' : 'gap' : 'manual_capture', lastContinuousAt: scheduled && continuous ? capturedAt : null, message: gapMessage };
    } catch (error: any) {
      this.store.db.prepare("UPDATE pitr_artifacts SET status='failed',message=? WHERE capture_id=? AND status='pending'").run(String(error?.message || error).slice(0, 500), captureId);
      if (scheduled) this.recordPitrCaptureState(connectionId, storageTargetId, null, 'gap', String(error?.message || error).slice(0, 500), null);
      throw error;
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      this.pitrCapturing.delete(connectionId);
      this.releaseWorkClaim(claimKey, claimToken);
    }
  }
  private recordPitrCaptureState(connectionId: string, storageTargetId: string, sourceState: any, gapStatus: string, message: string, lastContinuousAt: string | null) {
    const interval = Math.max(1, Math.min(1440, Number(sourceState?.interval || 15)));
    this.store.db.prepare('UPDATE pitr_sources SET storage_target_id=?,last_scan_at=?,next_capture_at=?,gap_status=?,last_continuous_at=COALESCE(?,last_continuous_at),message=? WHERE connection_id=?').run(storageTargetId, this.store.now(), new Date(Date.now() + interval * 60000).toISOString(), gapStatus, lastContinuousAt, message, connectionId);
  }

  startPitrRehearsal(input: any) {
    const targetTime = parseUtcTargetTime(input.targetTime);
    if (targetTime.epoch > Date.now()) throw new BadRequestException('PITR target time cannot be in the future');
    const connectionId = String(input.connectionId || '');
    const runId = String(input.backupRunId || '');
    const recoveryConnectionId = String(input.recoveryConnectionId || '');
    const source = this.store.db.prepare('SELECT id,engine FROM database_connections WHERE id=? AND COALESCE(connection_purpose,\'backup\')<>\'recovery\'').get(connectionId) as any;
    const recovery = this.store.db.prepare("SELECT id,engine,connection_purpose as purpose FROM database_connections WHERE id=?").get(recoveryConnectionId) as any;
    if (!source) throw new BadRequestException('PITR source connection was not found');
    if (!recovery || recovery.purpose !== 'recovery') throw new BadRequestException('Select a dedicated recovery-only database connection');
    if (source.engine !== recovery.engine) throw new BadRequestException('The source and recovery server must use the same database engine');
    const row = this.store.db.prepare('SELECT r.*,j.backup_layout as jobLayout,j.backup_objects as jobObjects,j.compression as jobCompression,j.backup_encryption as jobEncryption FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id WHERE r.id=?').get(runId) as any;
    if (!row || row.status !== 'success' || row.database_connection_id !== connectionId) throw new BadRequestException('Select a successful backup run from the chosen PITR source');
    const sourceState = this.store.db.prepare('SELECT * FROM pitr_sources WHERE connection_id=?').get(connectionId) as any;
    if (!sourceState?.enabled || sourceState.base_job_id !== row.job_id) throw new BadRequestException('PITR capture is not configured for this backup schedule');
    const checkpoint = this.jsonValue(sourceState.checkpoint_json, {});
    if (sourceState.gap_status !== 'continuous' || !sourceState.last_continuous_at || checkpoint.baselineRunId !== row.id) throw new BadRequestException('PITR log coverage is not continuous for the selected baseline; a point-in-time rehearsal cannot be claimed');
    const coordinateAt = Date.parse(String(row.pitr_coordinate_at || ''));
    if (!Number.isFinite(coordinateAt) || targetTime.epoch < coordinateAt || targetTime.epoch > Date.parse(String(sourceState.last_continuous_at))) throw new BadRequestException('Requested recovery time is outside the verified baseline and continuous log coverage');
    if (row.database_scope !== 'all' || row.backup_layout !== 'single' || !row.pitr_log_file || !Number(row.pitr_log_position)) throw new BadRequestException('The selected backup is not a complete all-database PITR baseline with a recorded binlog coordinate');
    const databases = this.parseDatabaseList(row.database_names);
    if (!databases.length) throw new BadRequestException('The selected PITR baseline has no verifiable database expectation');
    this.parseExpectedObjects(row.expected_objects, databases);
    const rawObjects = this.jsonValue(row.backup_objects, {});
    if (Object.values(rawObjects).some(value => value === false)) throw new BadRequestException('The selected PITR baseline excludes database objects');
    if (row.connection_engine && row.connection_engine !== source.engine) throw new BadRequestException('The baseline engine does not match the source connection');
    const id = crypto.randomUUID();
    this.store.db.prepare('INSERT INTO pitr_rehearsals (id,connection_id,backup_run_id,recovery_connection_id,target_time,status,progress,stage,started_at,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, connectionId, runId, recoveryConnectionId, targetTime.iso, 'running', 1, 'queued', this.store.now(), JSON.stringify({ targetTime: targetTime.iso }));
    this.publishPitrRehearsals();
    void this.performPitrRehearsal(id).catch(error => { const message = String(error?.message || error).slice(0, 1200); this.setPitrRehearsal(id, { status: 'failed', progress: 100, stage: 'finished', errorMessage: message, evidence: { unexpectedFailure: message }, finished: true }); });
    return { ok: true, id, status: 'running', targetTime: targetTime.iso };
  }

  getPitrRehearsal(id: string) {
    const row = this.store.db.prepare('SELECT * FROM pitr_rehearsals WHERE id=?').get(id) as any;
    if (!row) throw new BadRequestException('PITR rehearsal not found');
    return this.pitrRehearsalView(row);
  }

  listPitrRehearsals() {
    const rows = this.store.db.prepare('SELECT * FROM pitr_rehearsals ORDER BY started_at DESC LIMIT 50').all() as any[];
    return rows.map(row => this.pitrRehearsalView(row));
  }

  private pitrRehearsalView(row: any) {
    return { id: row.id, connectionId: row.connection_id, backupRunId: row.backup_run_id, recoveryConnectionId: row.recovery_connection_id, targetTime: row.target_time, status: row.status, progress: Number(row.progress || 0), stage: row.stage, startedAt: row.started_at, finishedAt: row.finished_at, evidence: this.jsonValue(row.evidence_json, {}), errorMessage: row.error_message };
  }

  private publishPitrRehearsals() { this.realtime.publish('pitr_rehearsals', this.listPitrRehearsals()); }

  private setPitrRehearsal(id: string, update: { status?: string; progress?: number; stage?: string; evidence?: unknown; errorMessage?: string | null; finished?: boolean }) {
    const current = this.store.db.prepare('SELECT evidence_json FROM pitr_rehearsals WHERE id=?').get(id) as any;
    if (!current) return;
    const evidence = { ...this.jsonValue(current.evidence_json, {}), ...(update.evidence && typeof update.evidence === 'object' ? update.evidence as object : {}) };
    this.store.db.prepare('UPDATE pitr_rehearsals SET status=COALESCE(?,status),progress=COALESCE(?,progress),stage=COALESCE(?,stage),evidence_json=?,error_message=?,finished_at=CASE WHEN ? THEN ? ELSE finished_at END WHERE id=?').run(update.status || null, update.progress ?? null, update.stage || null, JSON.stringify(evidence), update.errorMessage === undefined ? null : update.errorMessage, update.finished ? 1 : 0, update.finished ? this.store.now() : null, id);
    this.publishPitrRehearsals();
  }

  private async performPitrRehearsal(id: string) {
    const row = this.store.db.prepare('SELECT t.*,r.filename,r.storage_location,r.storage_folder,r.storage_target_id,r.sha256,r.database_names,r.database_scope,r.backup_layout,r.backup_objects,r.expected_objects,r.compression,r.backup_encryption,r.pitr_log_file,r.pitr_log_position,r.pitr_coordinate_at,r.started_at as baseline_started_at,r.connection_engine,c.engine as source_engine,s.storage_target_id as pitr_storage_target_id,s.checkpoint_json,s.last_continuous_at,s.gap_status FROM pitr_rehearsals t JOIN backup_runs r ON r.id=t.backup_run_id JOIN database_connections c ON c.id=t.connection_id JOIN pitr_sources s ON s.connection_id=t.connection_id WHERE t.id=?').get(id) as any;
    if (!row) return;
    const targetTime = parseUtcTargetTime(row.target_time);
    const source = this.getConnection(String(row.connection_id));
    const destination = this.getConnection(String(row.recovery_connection_id));
    const createdDatabases: string[] = [];
    const tempFiles: Array<{ path: string; cleanup: boolean }> = [];
    let tempDir = '';
    let failure = '';
    let cleanupFailures: string[] = [];
    const evidence: Record<string, unknown> = { targetTime: targetTime.iso, baselineRunId: row.backup_run_id, baselineLogFile: row.pitr_log_file, baselineLogPosition: Number(row.pitr_log_position), cleanupDatabases: createdDatabases };
    try {
      const coverageCheckpoint = this.jsonValue(row.checkpoint_json, {});
      if (row.gap_status !== 'continuous' || !row.last_continuous_at || targetTime.epoch > Date.parse(String(row.last_continuous_at)) || coverageCheckpoint.baselineRunId !== row.backup_run_id) throw new BadRequestException('The requested target is outside currently verified continuous binlog coverage for this baseline');
      if (source.engine !== destination.engine || source.engine !== row.source_engine || (row.connection_engine && row.connection_engine !== source.engine)) throw new BadRequestException('The PITR baseline and recovery connection engines are incompatible');
      if (row.database_scope !== 'all' || row.backup_layout !== 'single' || !row.sha256 || !row.pitr_log_file || !Number(row.pitr_log_position) || !row.pitr_coordinate_at || targetTime.epoch < Date.parse(String(row.pitr_coordinate_at))) throw new BadRequestException('The baseline is missing all-database scope, a recorded checksum, or a valid binlog coordinate time');
      const databases = this.parseDatabaseList(row.database_names);
      if (!databases.length) throw new BadRequestException('The PITR baseline has no verifiable database list');
      const expectedObjects = this.parseExpectedObjects(row.expected_objects, databases);
      const mapping = makeScratchDatabaseNames(databases, `vb_pitr_${id.replace(/-/g, '').slice(0, 8)}`, crypto.randomBytes(32).toString('hex'));
      evidence.databaseMap = mapping;
      tempDir = fs.mkdtempSync(path.join(this.store.dataDir, 'tmp', `pitr-rehearsal-${id}-`));
      this.setPitrRehearsal(id, { progress: 8, stage: 'checking-coverage', evidence });
      const checkpoint = this.jsonValue(row.checkpoint_json, {});
      const expectedLogs = Array.isArray(checkpoint.visibleLogs) ? checkpoint.visibleLogs.map((name: unknown) => String(name)) : [];
      const baseIndex = expectedLogs.indexOf(String(row.pitr_log_file));
      if (baseIndex < 0 || !expectedLogs.length) throw new BadRequestException('The continuous-coverage checkpoint does not include the baseline binlog');
      const logs = expectedLogs.slice(baseIndex);
      const gaps = findBinlogSequenceGaps(logs);
      if (gaps.length) throw new BadRequestException(`PITR log sequence has gaps: ${gaps.join(', ')}`);
      const artifactRows = this.store.db.prepare("SELECT * FROM pitr_artifacts WHERE connection_id=? AND storage_target_id=? AND capture_kind='scheduled' AND status='captured' AND captured_at<=? ORDER BY captured_at DESC").all(row.connection_id, row.pitr_storage_target_id, row.last_continuous_at) as any[];
      const latestByLog = new Map<string, any>();
      for (const artifact of artifactRows) if (!latestByLog.has(String(artifact.binlog_name))) latestByLog.set(String(artifact.binlog_name), artifact);
      const missing = logs.filter((name: string) => !latestByLog.has(name));
      if (missing.length) throw new BadRequestException(`PITR artifacts are missing for: ${missing.join(', ')}`);
      const orderedArtifacts = logs.map((name: string) => latestByLog.get(name));
      evidence.logs = orderedArtifacts.map((item: any) => ({ name: item.binlog_name, sha256: item.sha256, capturedAt: item.captured_at, position: item.log_position, size: item.size_bytes }));
      this.setPitrRehearsal(id, { progress: 15, stage: 'downloading', evidence });

      const backupTarget = this.storage.get(String(row.storage_target_id));
      const baseDownload = await this.storage.download(backupTarget, String(row.filename), row.storage_location ? String(row.storage_location) : undefined, row.storage_folder ? String(row.storage_folder) : '');
      tempFiles.push(baseDownload);
      const baseArtifact = await this.stageAndVerifyDownload(baseDownload, row.sha256, true, cleanupFailures);
      if (baseArtifact !== baseDownload) tempFiles.push(baseArtifact);
      let baselineFile = baseArtifact.path;
      const compression = ['none', 'gzip', 'zip'].includes(row.compression) ? row.compression : String(row.filename).includes('.sql.gz') ? 'gzip' : String(row.filename).endsWith('.zip') || String(row.filename).endsWith('.zip.enc') ? 'zip' : 'none';
      const encrypted = row.backup_encryption === 'aes-256-gcm' || String(row.filename).endsWith('.enc');
      if (encrypted) { const decrypted = path.join(tempDir, compression === 'zip' ? 'baseline.zip' : compression === 'gzip' ? 'baseline.sql.gz' : 'baseline.sql'); await this.decryptFile(baselineFile, decrypted); baselineFile = decrypted; }
      if (compression === 'gzip') { const expanded = path.join(tempDir, 'baseline.sql'); await pipeline(fs.createReadStream(baselineFile), createGunzip(), new TempStorageLimitTransform(this.temporaryFileLimitBytes()), fs.createWriteStream(expanded, { mode: 0o600 })); baselineFile = expanded; }
      if (compression === 'zip') {
        const entry = this.validatedZipSqlEntries(baselineFile, { backupLayout: row.backup_layout, databaseScope: row.database_scope }, databases).find(item => item.name === 'backup.sql');
        if (!entry) throw new BadRequestException('PITR baseline ZIP has no backup.sql member');
        const extracted = path.join(tempDir, 'baseline.sql');
        await this.extractZipEntry(baselineFile, entry, extracted);
        baselineFile = extracted;
      }
      const rewrittenBaseline = path.join(tempDir, 'baseline-scratch.sql');
      await this.validatePitrSqlFile(baselineFile, databases);
      await this.rewritePitrSqlFile(baselineFile, mapping, rewrittenBaseline);
      await this.validatePitrSqlFile(rewrittenBaseline, Object.values(mapping));

      const logFiles: string[] = [];
      for (const [index, artifact] of orderedArtifacts.entries()) {
        const target = this.storage.get(String(artifact.storage_target_id));
        const rawDownload = await this.storage.download(target, String(artifact.binlog_name), artifact.storage_location ? String(artifact.storage_location) : undefined, String(artifact.storage_folder || ''));
        tempFiles.push(rawDownload);
        const downloaded = await this.stageAndVerifyDownload(rawDownload, artifact.sha256, true, cleanupFailures);
        if (downloaded !== rawDownload) tempFiles.push(downloaded);
        logFiles.push(downloaded.path);
        this.setPitrRehearsal(id, { progress: 18 + Math.floor((index + 1) / orderedArtifacts.length * 22), stage: 'downloading', evidence: { downloadedLogs: index + 1 } });
      }
      this.setPitrRehearsal(id, { progress: 42, stage: 'decoding-logs' });
      const decoded = path.join(tempDir, 'pitr-replay.sql');
      const binary = this.resolveBinlogBinary(source.engine);
      if (!this.executableAvailable(binary)) throw new BadRequestException(`Bundled ${source.engine} binlog utility is unavailable; install the portable database tools first`);
      const replayOptions = pitrBinlogReplayOptions(source.engine, Number(row.pitr_log_position), targetTime.iso, mapping);
      const args = [...this.clientToolArgs(binary), ...replayOptions, ...logFiles];
      await this.decodeBinlogs(binary, args, decoded);
      const rewrittenReplay = path.join(tempDir, 'pitr-replay-scratch.sql');
      await this.validatePitrSqlFile(decoded, [...Object.values(mapping), ...databases]);
      await this.rewritePitrSqlFile(decoded, mapping, rewrittenReplay);
      await this.validatePitrSqlFile(rewrittenReplay, Object.values(mapping));

      const [availableRows] = await this.withNativeDatabaseConnection(destination, client => client.query('SHOW DATABASES') as Promise<any>);
      const available = new Set((availableRows as any[]).map(item => String(item.Database || Object.values(item)[0] || '')));
      for (const name of Object.values(mapping)) {
        if (available.has(name)) throw new BadRequestException(`Generated scratch database ${name} already exists. No data was overwritten.`);
      }
      for (const name of Object.values(mapping)) {
        await this.executeMysql(destination, `CREATE DATABASE ${this.quoteIdentifier(name)}`);
        createdDatabases.push(name);
      }
      this.setPitrRehearsal(id, { progress: 58, stage: 'restoring-baseline', evidence: { createdDatabases: [...createdDatabases] } });
      await this.restoreSql(destination, rewrittenBaseline);
      this.setPitrRehearsal(id, { progress: 78, stage: 'replaying-binlogs' });
      await this.restoreSql(destination, rewrittenReplay);
      this.setPitrRehearsal(id, { progress: 92, stage: 'verifying' });
      const mappedExpectedObjects = Object.fromEntries(databases.map(database => [mapping[database], expectedObjects[database]]));
      const verification = await this.verifyRestore(destination, Object.values(mapping), mappedExpectedObjects);
      evidence.verification = verification;
      if (verification.status !== 'passed') throw new BadRequestException(`PITR replay completed but verification did not pass: ${verification.message}`);
    } catch (error: any) {
      failure = String(error?.message || error).slice(0, 1200);
    } finally {
      for (const database of [...createdDatabases].reverse()) {
        try { await this.executeMysql(destination, `DROP DATABASE ${this.quoteIdentifier(database)}`); }
        catch (error: any) { cleanupFailures.push(`${database}: ${String(error?.message || error).slice(0, 300)}`); }
      }
      for (const file of tempFiles) if (file.cleanup) {
        try { fs.rmSync(file.path, { force: true }); fs.rmSync(path.dirname(file.path), { recursive: true, force: true }); }
        catch (error: any) { cleanupFailures.push(`temporary download ${path.basename(file.path)}: ${String(error?.message || error).slice(0, 300)}`); }
      }
      if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (error: any) { cleanupFailures.push(`temporary files: ${String(error?.message || error).slice(0, 300)}`); } }
    }
    evidence.cleanup = { createdDatabases, removed: createdDatabases.filter(name => !cleanupFailures.some(item => item.startsWith(`${name}:`))), failures: cleanupFailures };
    if (failure || cleanupFailures.length) {
      const message = [failure, cleanupFailures.length ? `Cleanup warning: ${cleanupFailures.join('; ')}` : ''].filter(Boolean).join(' · ');
      const status = failure ? cleanupFailures.length ? 'failed_with_cleanup_warning' : 'failed' : 'warning';
      this.setPitrRehearsal(id, { status, progress: 100, stage: 'finished', errorMessage: message, evidence, finished: true });
      return;
    }
    this.setPitrRehearsal(id, { status: 'passed', progress: 100, stage: 'finished', evidence, errorMessage: null, finished: true });
  }

  private parseDatabaseList(value: unknown): string[] { try { const items = JSON.parse(String(value || '[]')); return Array.isArray(items) ? [...new Set(items.map((item: unknown) => String(item).trim()).filter(Boolean))] : []; } catch { return []; } }
  private jsonValue(value: unknown, fallback: any) { try { return JSON.parse(String(value || '')) ?? fallback; } catch { return fallback; } }
  private async validatePitrSqlFile(file: string, allowedDatabases: string[]) {
    let carry = '';
    for await (const chunk of fs.createReadStream(file)) {
      const combined = carry + String(chunk);
      validatePitrSql(combined, allowedDatabases);
      carry = combined.slice(-2048);
    }
    if (carry) validatePitrSql(carry, allowedDatabases);
  }
  private lastSqlStatementBoundary(contents: string) {
    let quote = '';
    let lineComment = false;
    let blockComment = false;
    let boundary = 0;
    for (let index = 0; index < contents.length; index++) {
      const current = contents[index];
      const next = contents[index + 1];
      if (lineComment) { if (current === '\n') lineComment = false; continue; }
      if (blockComment) { if (current === '*' && next === '/') { blockComment = false; index++; } continue; }
      if (quote) {
        if (current === '\\') { index++; continue; }
        if (current === quote) {
          if (next === quote) { index++; continue; }
          quote = '';
        }
        continue;
      }
      if (current === '\'' || current === '"' || current === '`') { quote = current; continue; }
      if ((current === '-' && next === '-' && /\s/.test(contents[index + 2] || '')) || current === '#') { lineComment = true; if (current === '-') index++; continue; }
      if (current === '/' && next === '*') { blockComment = true; index++; continue; }
      if (current === ';') boundary = index + 1;
    }
    return boundary;
  }
  private async rewritePitrSqlFile(input: string, mapping: Record<string, string>, output: string) {
    let carry = '';
    const service = this;
    const maximumStatementBytes = 8 * 1024 * 1024;
    const transform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const combined = carry + chunk.toString('utf8');
        const boundary = service.lastSqlStatementBoundary(combined);
        if (boundary === 0) {
          carry = combined;
          if (Buffer.byteLength(carry) > maximumStatementBytes) { callback(new BadRequestException('A PITR SQL statement exceeds the safe rewrite limit')); return; }
          callback();
          return;
        }
        const safe = combined.slice(0, boundary);
        carry = combined.slice(boundary);
        if (Buffer.byteLength(carry) > maximumStatementBytes) { callback(new BadRequestException('A PITR SQL statement exceeds the safe rewrite limit')); return; }
        callback(null, rewritePitrSqlDatabases(safe, mapping));
      },
      flush(callback) { callback(null, rewritePitrSqlDatabases(carry, mapping)); }
    });
    await pipeline(fs.createReadStream(input), transform, new TempStorageLimitTransform(this.temporaryFileLimitBytes()), fs.createWriteStream(output, { mode: 0o600 }));
  }
  private async decodeBinlogs(binary: string, args: string[], output: string) {
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      let child: ReturnType<typeof spawn>;
      try { child = spawn(binary, args, { env: { ...process.env, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
      catch (error: any) { reject(new BadRequestException(this.clientStartMessage(binary, error))); return; }
      child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      if (!child.stdout) { reject(new BadRequestException(`${binary} did not provide decoded binlog output`)); return; }
      const outputPipeline = pipeline(child.stdout, new TempStorageLimitTransform(this.temporaryFileLimitBytes()), fs.createWriteStream(output, { mode: 0o600 }));
      const exit = new Promise<number>((done, fail) => {
        child.once('error', error => fail(new BadRequestException(this.clientStartMessage(binary, error))));
        child.once('close', code => done(Number(code ?? 1)));
      });
      void Promise.all([outputPipeline, exit]).then(([, code]) => code === 0 ? resolve() : reject(new BadRequestException(`${binary} binlog replay preparation failed with code ${code}: ${stderr.slice(0, 1000)}`)), error => { try { child.kill(); } catch {} reject(error); });
    });
  }
  private async listAvailableTables(connection: DatabaseConnection, database: string) {
    if (this.isVirtualDatabase(database)) return { tables: [], views: [] };
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
  private async appendViewDefinitions(connection: DatabaseConnection, database: string, views: string[], output: string, processId?: string) {
    if (!views.length) return 0;
    const definitions: string[] = [];
    await this.withNativeDatabaseConnection(connection, async client => {
      for (const view of views) {
        try {
          const qualified = `${this.quoteIdentifier(database)}.${this.quoteIdentifier(view)}`;
          const [rows] = await client.query(`SHOW CREATE VIEW ${qualified}`);
          const row = (rows as any[])[0] || {};
          const createSql = String(row['Create View'] || row['Create Table'] || Object.values(row).find(value => typeof value === 'string' && /\bCREATE\b/i.test(value)) || '').trim();
          if (!createSql) throw new Error('The server returned no CREATE VIEW definition');
          definitions.push(`/*!50001 DROP VIEW IF EXISTS ${qualified} */;\n/*!50001 ${createSql} */;\n`);
        } catch (error: any) {
          const detail = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 240);
          if (processId) this.addProcessLog(processId, `Skipping view ${database}.${view}: ${detail}`);
        }
      }
    });
    if (definitions.length) fs.appendFileSync(output, `\n-- VaultBack view definitions\n${definitions.join('\n')}`, { encoding: 'utf8' });
    return definitions.length;
  }
  private async dumpDatabaseObjects(connection: DatabaseConnection, database: string, available: { tables: string[]; views: string[] }, objects: BackupObjectOptions, output: string, processId?: string) {
    if (this.isVirtualDatabase(database)) return;
    // Do not pass views to mariadb-dump. Its view serializer can fail with a
    // misleading "ds_view" error on valid MariaDB/MySQL views. Tables,
    // routines, and events remain handled by the native dump utility.
    const ignored = [...available.tables, ...available.views].map(name => `--ignore-table=${database}.${name}`);
    await this.dumpWithArgs(connection, output, ['--no-data', ...ignored, database], processId, { includeRoutines: objects.routines, includeEvents: objects.events, includeTriggers: false });
    if (objects.views) {
      const count = await this.appendViewDefinitions(connection, database, available.views, output, processId);
      if (processId && count) this.addProcessLog(processId, `Included ${count} view definition(s) for ${database}`);
    }
  }
  private clientStartMessage(binary: string, error: any) {
    if (error?.code === 'EPERM') return `Windows blocked VaultBack from launching ${path.basename(binary)}. Confirm the bundled tool is executable and run VaultBack under a Windows/PM2 account allowed to start child processes.`;
    if (error?.code === 'ENOENT') return `Bundled database tool not found: ${binary}. Open Settings and use Repair and redownload tools.`;
    return `Could not start ${binary}: ${error?.message || error}`;
  }
  private dump(connection: DatabaseConnection, output: string, processId: string | undefined, insertMode: BackupJob['insertMode'], pitrCoordinates = false) { if (connection.databaseScope === 'all' && !connection.databases.length) throw new BadRequestException('No user databases are available to back up'); const dumpArgs = ['--databases', ...connection.databases]; return this.dumpWithArgs(connection, output, dumpArgs, processId, { insertMode, pitrCoordinates }); }
  private dumpDatabase(connection: DatabaseConnection, database: string, output: string, processId: string | undefined, insertMode: BackupJob['insertMode']) { return this.dumpWithArgs(connection, output, ['--databases', database], processId, { insertMode }); }
  private dumpTable(connection: DatabaseConnection, database: string, table: string, output: string, processId: string | undefined, includeTriggers: boolean, insertMode: BackupJob['insertMode']) { return this.dumpWithArgs(connection, output, [database, table], processId, { includeRoutines: false, includeEvents: false, includeTriggers, insertMode }); }
  private dumpWithArgs(connection: DatabaseConnection, output: string, dumpArgs: string[], processId?: string, options: { includeRoutines?: boolean; includeEvents?: boolean; includeTriggers?: boolean; insertMode?: BackupJob['insertMode']; pitrCoordinates?: boolean } = {}) { return new Promise<void>((resolve, reject) => { const binary = this.resolveClientBinary(connection.engine, true); const mysqlClient = isWithin(path.join(process.cwd(), 'tools', 'mysql'), binary); const transportArgs = mysqlClient ? [connection.ssl ? '--ssl-mode=REQUIRED' : '--ssl-mode=DISABLED'] : [connection.ssl ? '--ssl' : '--skip-ssl']; const args = [...this.clientToolArgs(binary), `--host=${connection.host}`, `--port=${connection.port}`, `--user=${connection.username}`, ...transportArgs, '--single-transaction', ...(options.includeRoutines === false ? [] : ['--routines']), ...(options.includeEvents === false ? [] : ['--events']), ...(options.includeTriggers === false ? [] : ['--triggers']), '--hex-blob', ...(options.insertMode === 'single-row' ? ['--skip-extended-insert'] : []), ...(options.pitrCoordinates ? [pitrDumpCoordinateOption(connection.engine)] : []), ...dumpArgs]; const child = spawn(binary, args, { env: { ...process.env, MYSQL_PWD: connection.password }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); const out = fs.createWriteStream(output, { mode: 0o600 }); let stderr = ''; child.stdout.pipe(out); child.stderr.on('data', chunk => { const text = chunk.toString(); stderr += text; if (processId) this.addProcessLog(processId, text); }); child.on('error', error => { out.close(); if (processId) this.addProcessLog(processId, this.clientStartMessage(binary, error)); reject(new Error(this.clientStartMessage(binary, error))); }); child.on('close', code => { out.close(); if (code === 0) resolve(); else reject(new Error(`${binary} failed with code ${code}: ${stderr.slice(0, 800)}`)); }); }); }
  private async sha256(file: string) { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
}
