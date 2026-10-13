import { BadRequestException, Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { BackupService } from '../backup/backup.service';
import { StorageService } from '../storage/storage.service';
import { RealtimeService } from '../system/realtime.service';
import { nextCron, safeFilePart } from '../backup/backup.utils';
import { PitrConfigurationDto, PitrRehearsalDto } from '../common/request-dtos';

@Injectable()
export class RecoveryService {
  constructor(private readonly store: DatabaseService, private readonly backups: BackupService, private readonly storage: StorageService, private readonly realtime: RealtimeService) {}

  listPlans() {
    this.store.assertEncryptionHealthy();
    const rows = this.store.db.prepare(`SELECT p.*,j.name as job_name,c.name as destination_name,c.connection_purpose as destination_purpose FROM recovery_plans p JOIN backup_jobs j ON j.id=p.job_id JOIN database_connections c ON c.id=p.destination_connection_id ORDER BY p.name`).all() as any[];
    return rows.map(row => this.planView(row));
  }

  savePlan(input: any) {
    this.store.assertEncryptionHealthy();
    const destinationConnectionId = String(input.recoveryConnectionId || input.destinationConnectionId || '').trim();
    if (!input.name || !input.jobId || !destinationConnectionId) throw new BadRequestException('Name, schedule, and recovery destination are required');
    if (!this.store.db.prepare('SELECT id FROM backup_jobs WHERE id=?').get(input.jobId)) throw new BadRequestException('Backup schedule not found');
    const destination = this.store.db.prepare('SELECT id,connection_purpose as purpose FROM database_connections WHERE id=?').get(destinationConnectionId) as any;
    if (!destination) throw new BadRequestException('Recovery destination database connection not found');
    if (input.recoveryConnectionId && destination.purpose !== 'recovery') throw new BadRequestException('Select a dedicated recovery database connection');
    const cronExpression = String(input.cronExpression || '0 4 * * 0');
    const timezone = String(input.timezone || 'UTC');
    const next = nextCron(cronExpression, new Date(), timezone).toISOString();
    const prefix = safeFilePart(String(input.testDatabasePrefix || 'vaultback_recovery_test')).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40) || 'vaultback_recovery_test';
    const id = String(input.id || crypto.randomUUID());
    this.store.db.prepare(`INSERT INTO recovery_plans (id,name,job_id,destination_connection_id,cron_expression,timezone,enabled,test_database_prefix,next_test_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,job_id=excluded.job_id,destination_connection_id=excluded.destination_connection_id,cron_expression=excluded.cron_expression,timezone=excluded.timezone,enabled=excluded.enabled,test_database_prefix=excluded.test_database_prefix,next_test_at=excluded.next_test_at`).run(id, String(input.name).trim(), input.jobId, destinationConnectionId, cronExpression, timezone, input.enabled === false ? 0 : 1, prefix, next, this.store.now());
    return this.planView(this.store.db.prepare(`SELECT p.*,j.name as job_name,c.name as destination_name,c.connection_purpose as destination_purpose FROM recovery_plans p JOIN backup_jobs j ON j.id=p.job_id JOIN database_connections c ON c.id=p.destination_connection_id WHERE p.id=?`).get(id) as any);
  }

  deletePlan(id: string) {
    this.store.db.prepare('DELETE FROM recovery_plans WHERE id=?').run(id);
    return { ok: true };
  }

  listRecoveryConnections() {
    this.store.assertEncryptionHealthy();
    return this.store.db.prepare("SELECT id,name,engine,host,port,username,ssl,created_at as createdAt FROM database_connections WHERE connection_purpose='recovery' ORDER BY name").all();
  }

  saveRecoveryConnection(input: any) {
    this.store.assertEncryptionHealthy();
    if (!input.name || !input.host || !input.username) throw new BadRequestException('Name, host, and username are required');
    if (input.host === '0.0.0.0' || input.host === '::') throw new BadRequestException('Use the actual recovery database server address, not a bind address');
    const id = String(input.id || crypto.randomUUID());
    const old = this.store.db.prepare("SELECT password_enc,connection_purpose FROM database_connections WHERE id=?").get(id) as any;
    if (old && old.connection_purpose !== 'recovery') throw new BadRequestException('That ID belongs to a normal backup connection');
    const password = typeof input.password === 'string' && input.password.length ? this.store.encrypt(input.password) : old?.password_enc || this.store.encrypt('');
    this.store.db.prepare(`INSERT INTO database_connections (id,name,engine,host,port,username,password_enc,database_name,database_scope,database_names,ssl,connection_purpose,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,engine=excluded.engine,host=excluded.host,port=excluded.port,username=excluded.username,password_enc=excluded.password_enc,ssl=excluded.ssl,connection_purpose='recovery'`).run(id, String(input.name).trim(), input.engine || 'mysql', String(input.host).trim(), Number(input.port || 3306), String(input.username).trim(), password, '', 'selected', '[]', input.ssl ? 1 : 0, 'recovery', this.store.now());
    return this.listRecoveryConnections().find((item: any) => item.id === id);
  }

  async testRecoveryConnection(input: any) {
    return this.backups.testConnection(input);
  }

  deleteRecoveryConnection(id: string) {
    const used = this.store.db.prepare('SELECT id FROM recovery_plans WHERE destination_connection_id=? LIMIT 1').get(id);
    if (used) throw new BadRequestException('This recovery server is used by a recovery plan. Delete or update the plan first.');
    this.store.db.prepare("DELETE FROM database_connections WHERE id=? AND connection_purpose='recovery'").run(id);
    return { ok: true };
  }

  async runTest(planId: string) {
    const plan = this.store.db.prepare('SELECT * FROM recovery_plans WHERE id=?').get(planId) as any;
    if (!plan) throw new BadRequestException('Recovery plan not found');
    const active = this.store.db.prepare("SELECT id FROM recovery_tests WHERE plan_id=? AND status='running'").get(planId);
    if (active) throw new BadRequestException('A recovery test is already running for this plan');
    const run = this.store.db.prepare(`SELECT r.* FROM backup_runs r WHERE r.job_id=? AND r.status='success' AND r.filename IS NOT NULL ORDER BY COALESCE(r.finished_at,r.started_at) DESC LIMIT 1`).get(plan.job_id) as any;
    if (!run) throw new BadRequestException('No completed backup is available for this schedule');
    if (!run.storage_target_id) throw new BadRequestException('The selected historical run has no recorded storage target and cannot be tested safely');
    const target = this.storage.get(String(run.storage_target_id));
    const available = await this.storage.isAvailable(target, String(run.filename), run.storage_location ? String(run.storage_location) : undefined, run.storage_folder ? String(run.storage_folder) : '');
    if (!available) throw new BadRequestException('The latest backup artifact is missing from its storage target');
    const started = Date.now();
    const testId = crypto.randomUUID();
    const suffix = crypto.randomBytes(16).toString('hex');
    const databasePrefix = String(plan.test_database_prefix || 'vaultback_recovery_test').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30) || 'vaultback_recovery_test';
    const databaseName = `${databasePrefix}_${suffix}`;
    this.store.db.prepare('INSERT INTO recovery_tests (id,plan_id,source_run_id,status,started_at,test_database_name,destination_connection_id,evidence_json) VALUES (?,?,?,?,?,?,?,?)').run(testId, planId, run.id, 'running', this.store.now(), databaseName, plan.destination_connection_id, JSON.stringify({ sourceFilename: run.filename, sourceFinishedAt: run.finished_at || run.started_at }));
    this.publish();
    try {
      const result = await this.backups.restoreRunForRecoveryTest(String(run.id), String(plan.destination_connection_id), databaseName);
      const finished = Date.now();
      const rpo = Math.max(0, Math.round((finished - Date.parse(String(run.finished_at || run.started_at))) / 1000));
      const rto = Math.max(0, Math.round((finished - started) / 1000));
      const status = result.cleanupOk === false ? 'warning' : 'passed';
      const message = result.cleanupOk === false ? `Restore verified, but disposable database cleanup needs manual review: ${result.cleanupMessage}` : 'Backup restored, verified, and disposable database removed';
      const checkedObjects = Array.isArray(result.verification?.details) ? result.verification.details.length : 0;
      this.store.db.prepare('UPDATE recovery_tests SET status=?,finished_at=?,rpo_seconds=?,rto_seconds=?,objects_expected=?,objects_restored=?,evidence_json=?,error_message=? WHERE id=?').run(status, this.store.now(), rpo, rto, checkedObjects, result.verification?.status === 'passed' ? checkedObjects : 0, JSON.stringify({ ...result.verification, sourceRunId: run.id, sourceFinishedAt: run.finished_at || run.started_at, cleanupOk: result.cleanupOk !== false, cleanupMessage: result.cleanupMessage || '' }), status === 'warning' ? result.cleanupMessage : null, testId);
      this.store.db.prepare('UPDATE recovery_plans SET last_test_at=?,next_test_at=?,last_status=?,last_message=? WHERE id=?').run(this.store.now(), nextCron(plan.cron_expression, new Date(), plan.timezone).toISOString(), status, message, planId);
      this.publish();
      return { ok: true, id: testId, status, message, rpoSeconds: rpo, rtoSeconds: rto };
    } catch (error: any) {
      const message = String(error?.message || error).slice(0, 1000);
      this.store.db.prepare('UPDATE recovery_tests SET status=?,finished_at=?,error_message=? WHERE id=?').run('failed', this.store.now(), message, testId);
      this.store.db.prepare('UPDATE recovery_plans SET last_test_at=?,next_test_at=?,last_status=?,last_message=? WHERE id=?').run(this.store.now(), nextCron(plan.cron_expression, new Date(), plan.timezone).toISOString(), 'failed', message, planId);
      this.publish();
      throw new BadRequestException(`Recovery test failed: ${message}`);
    }
  }

  listTests(planId?: string) {
    const where = planId ? 'WHERE t.plan_id=?' : '';
    const params = planId ? [planId] : [];
    const rows = this.store.db.prepare(`SELECT t.*,p.name as plan_name,r.filename FROM recovery_tests t JOIN recovery_plans p ON p.id=t.plan_id LEFT JOIN backup_runs r ON r.id=t.source_run_id ${where} ORDER BY t.started_at DESC LIMIT 100`).all(...params) as any[];
    return rows.map(row => ({ id: row.id, planId: row.plan_id, planName: row.plan_name, sourceRunId: row.source_run_id, filename: row.filename, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, testDatabaseName: row.test_database_name, rpoSeconds: row.rpo_seconds, rtoSeconds: row.rto_seconds, objectsExpected: row.objects_expected, objectsRestored: row.objects_restored, evidence: this.json(row.evidence_json), errorMessage: row.error_message }));
  }

  policy() {
    const now = Date.now();
    const jobs = this.store.db.prepare('SELECT * FROM backup_jobs ORDER BY name').all() as any[];
    const items = jobs.flatMap(job => {
      const runs = this.store.db.prepare(`SELECT r.*,r.database_connection_id as run_connection_id,r.storage_target_id as run_storage_id,c.name as connection_name,s.name as storage_name,s.type as storage_type FROM backup_runs r JOIN backup_jobs j ON j.id=r.job_id LEFT JOIN database_connections c ON c.id=r.database_connection_id LEFT JOIN storage_targets s ON s.id=r.storage_target_id WHERE r.job_id=? AND r.status='success' ORDER BY COALESCE(r.finished_at,r.started_at) DESC`).all(job.id) as any[];
      const latestByPair = new Map<string, any>();
      for (const run of runs) {
        const key = `${run.run_connection_id || ''}\u0000${run.run_storage_id || ''}`;
        if (!latestByPair.has(key)) latestByPair.set(key, run);
      }
      const pairRuns = [...latestByPair.values()];
      const candidates = pairRuns.length ? pairRuns : [null];
      return candidates.map(latest => {
        const age = latest ? Math.max(0, Math.round((now - Date.parse(String(latest.finished_at || latest.started_at))) / 1000)) : null;
        const findings: any[] = [];
        if (!latest) findings.push({ severity: 'critical', code: 'no_success', title: 'No successful recovery point', detail: 'Run this schedule manually and confirm the artifact is downloadable.' });
        else if (age !== null && age > 48 * 3600) findings.push({ severity: 'high', code: 'stale', title: 'Latest backup is stale', detail: `The latest successful artifact is ${Math.round(age / 3600)} hours old.` });
        if (latest) {
          const tested = this.store.db.prepare("SELECT t.status,t.evidence_json,t.error_message FROM recovery_tests t JOIN recovery_plans p ON p.id=t.plan_id WHERE p.job_id=? AND t.source_run_id=? ORDER BY t.started_at DESC LIMIT 1").get(job.id, latest.id) as any;
          if (!tested || !['passed', 'warning'].includes(String(tested.status))) findings.push({ severity: 'high', code: 'untested', title: 'Latest recovery point has not been proven', detail: 'Create a Recovery Assurance plan and run a restore test against this recorded backup run.' });
          else if (tested.status === 'warning') findings.push({ severity: 'medium', code: 'cleanup_warning', title: 'Restore-test cleanup needs review', detail: String(tested.error_message || 'Review the recorded recovery-test evidence for cleanup warnings.') });
        } else findings.push({ severity: 'high', code: 'untested', title: 'Restore has not been proven', detail: 'Create a Recovery Assurance plan and run an isolated restore test.' });
        const targetId = latest?.run_storage_id || null;
        const immutability = targetId ? this.storage.immutabilityStatus(String(targetId)) : { providerEnforced: false, configured: false, message: 'No storage target was recorded for this run.' };
        if (!immutability.providerEnforced) findings.push({ severity: 'medium', code: 'immutability', title: immutability.configured ? 'Immutable protection needs verification' : 'Immutable protection is not configured', detail: immutability.message });
        const metadata = latest ? {
          runId: latest.id,
          connectionId: latest.run_connection_id,
          connectionName: latest.connection_name,
          storageTargetId: targetId,
          databaseScope: latest.database_scope || null,
          databases: this.json(latest.database_names),
          backupLayout: latest.backup_layout || null,
          backupObjects: this.json(latest.backup_objects),
          compression: latest.compression || null,
          backupEncryption: latest.backup_encryption || null,
          insertMode: latest.insert_mode || null,
          connectionEngine: latest.connection_engine || null,
          metadataComplete: Boolean(latest.database_connection_id && latest.database_scope && latest.database_names && latest.backup_layout && latest.expected_objects && latest.compression && latest.backup_encryption !== null && latest.storage_target_id)
        } : null;
        if (metadata && !metadata.metadataComplete) findings.push({ severity: 'high', code: 'run_metadata', title: 'Run recovery metadata is incomplete', detail: 'This historical run lacks enough recorded source, scope, layout, compression, encryption, or storage details for a reliable restore decision.' });
        return { jobId: job.id, jobName: job.name, runId: latest?.id || null, connectionName: latest?.connection_name || null, storageName: latest?.storage_name || null, storageType: latest?.storage_type || null, latestBackupAt: latest?.finished_at || latest?.started_at || null, metadata, findings, risk: findings.some(item => item.severity === 'critical') ? 'critical' : findings.some(item => item.severity === 'high') ? 'high' : findings.length ? 'medium' : 'ready' };
      });
    });
    return { generatedAt: this.store.now(), summary: { critical: items.filter(i => i.risk === 'critical').length, high: items.filter(i => i.risk === 'high').length, medium: items.filter(i => i.risk === 'medium').length, ready: items.filter(i => i.risk === 'ready').length }, items };
  }

  async pitrStatus() {
    const rows = this.store.db.prepare("SELECT id,name,engine,host FROM database_connections WHERE COALESCE(connection_purpose,'backup') <> 'recovery' ORDER BY name").all() as any[];
    const items = [];
    for (const row of rows) {
      try {
        const source = this.store.db.prepare('SELECT storage_target_id as storageTargetId,base_job_id as baseJobId,enabled,capture_interval_minutes as captureIntervalMinutes,last_capture_at as lastCaptureAt,last_continuous_at as lastContinuousAt,next_capture_at as nextCaptureAt,gap_status as gapStatus,checkpoint_json as checkpointJson,message FROM pitr_sources WHERE connection_id=?').get(row.id) as any;
        const artifactCount = Number((this.store.db.prepare("SELECT COUNT(*) as count FROM pitr_artifacts WHERE connection_id=? AND capture_kind='scheduled' AND status='captured'").get(row.id) as any)?.count || 0);
        const inspection = await this.backups.inspectPitr(row.id);
        const checkpoint = this.json(source?.checkpointJson);
        const latestBaseline = source?.baseJobId ? this.store.db.prepare("SELECT id,pitr_log_file as logFile,pitr_log_position as logPosition,pitr_coordinate_at as coordinateAt,expected_objects as expectedObjects,database_names as databaseNames FROM backup_runs WHERE job_id=? AND database_connection_id=? AND status='success' AND pitr_log_file IS NOT NULL AND pitr_log_position IS NOT NULL ORDER BY COALESCE(finished_at,started_at) DESC LIMIT 1").get(source.baseJobId, row.id) as any : null;
        const baselineDatabases = this.json(latestBaseline?.databaseNames);
        const baselineExpectedObjects = this.json(latestBaseline?.expectedObjects);
        const baselineObjectsComplete = Array.isArray(baselineDatabases) && baselineDatabases.length > 0 && Object.keys(baselineExpectedObjects).length === baselineDatabases.length && baselineDatabases.every(database => Array.isArray(baselineExpectedObjects[database]) && baselineExpectedObjects[database].every((name: unknown) => typeof name === 'string' && name.trim()));
        const currentBaseline = Boolean(latestBaseline && baselineObjectsComplete && checkpoint.baselineRunId === latestBaseline.id && checkpoint.baselineFile === latestBaseline.logFile && Number(checkpoint.baselinePosition) === Number(latestBaseline.logPosition));
        const status = !source?.enabled ? 'not_configured' : source.gapStatus === 'continuous' && source.lastContinuousAt && currentBaseline ? 'ready' : source.gapStatus === 'gap' ? 'gap' : 'not_proven';
        const baseJob = source?.baseJobId ? this.store.db.prepare('SELECT name FROM backup_jobs WHERE id=?').get(source.baseJobId) as any : null;
        const message = !source?.enabled
          ? 'PITR capture is not configured. Binary logging alone does not prove a recoverable chain.'
          : source.gapStatus === 'gap'
            ? source.message
            : currentBaseline
              ? source.message
              : 'A new baseline is waiting for a complete binary-log capture.';
        items.push({ ...inspection, connectionId: row.id, name: row.name, engine: row.engine, storageTargetId: source?.storageTargetId || null, baseJobId: source?.baseJobId || null, baseJobName: baseJob?.name || null, baselineRunId: currentBaseline ? latestBaseline.id : latestBaseline?.id || null, baselineCoordinateAt: latestBaseline?.coordinateAt || null, baselineLogFile: latestBaseline?.logFile || null, enabled: Boolean(source?.enabled), captureIntervalMinutes: source?.captureIntervalMinutes || null, lastCaptureAt: source?.lastCaptureAt || null, lastContinuousAt: source?.lastContinuousAt || null, nextCaptureAt: source?.nextCaptureAt || null, artifactCount, gapStatus: source?.gapStatus || 'unknown', status, message });
      }
      catch (error: any) { items.push({ connectionId: row.id, name: row.name, engine: row.engine, status: 'error', message: String(error?.message || error).slice(0, 300) }); }
    }
    return { checkedAt: this.store.now(), items, rehearsals: this.backups.listPitrRehearsals() };
  }
  capturePitr(connectionId: string, storageTargetId: string) { return this.backups.capturePitr(connectionId, storageTargetId); }

  savePitrConfiguration(input: PitrConfigurationDto) {
    const connection = this.store.db.prepare("SELECT id,engine,connection_purpose as purpose FROM database_connections WHERE id=?").get(input.connectionId) as any;
    if (!connection || connection.purpose === 'recovery') throw new BadRequestException('Select an existing MySQL or MariaDB source connection');
    if (!['mysql', 'mariadb'].includes(String(connection.engine))) throw new BadRequestException('PITR capture is supported only for MySQL and MariaDB');
    const job = this.store.db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(input.backupJobId) as any;
    if (!job || !job.enabled) throw new BadRequestException('Choose an enabled backup schedule');
    if (job.database_scope !== 'all' || job.backup_layout !== 'single') throw new BadRequestException('PITR requires a single-layout, all-database backup schedule');
    const objects = this.json(job.backup_objects);
    if (objects.views === false || objects.routines === false || objects.triggers === false || objects.events === false) throw new BadRequestException('The PITR baseline must include views, routines, triggers, and events');
    const links = this.store.db.prepare('SELECT connection_id FROM backup_job_connections WHERE job_id=?').all(job.id) as any[];
    const linked = links.length ? links.some(link => link.connection_id === connection.id) : job.database_connection_id === connection.id;
    if (!linked) throw new BadRequestException('The selected schedule does not include this source connection');
    this.storage.get(input.storageTargetId);
    const interval = Math.max(1, Math.min(1440, Number(input.captureIntervalMinutes || 15)));
    const enabled = input.enabled === false ? 0 : 1;
    this.store.db.prepare(`INSERT INTO pitr_sources (connection_id,storage_target_id,enabled,capture_interval_minutes,base_job_id,next_capture_at,gap_status,message) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET storage_target_id=excluded.storage_target_id,enabled=excluded.enabled,capture_interval_minutes=excluded.capture_interval_minutes,base_job_id=excluded.base_job_id,next_capture_at=excluded.next_capture_at,gap_status=CASE WHEN excluded.enabled=0 THEN 'disabled' ELSE 'unknown' END,message=CASE WHEN excluded.enabled=0 THEN 'Scheduled capture is disabled' ELSE 'Waiting for a new baseline backup with coordinates' END`).run(connection.id, input.storageTargetId, enabled, interval, job.id, enabled ? this.store.now() : null, enabled ? 'unknown' : 'disabled', enabled ? 'Waiting for a new baseline backup with coordinates' : 'Scheduled capture is disabled');
    return { ok: true, connectionId: connection.id, enabled: Boolean(enabled), backupJobId: job.id, storageTargetId: input.storageTargetId, captureIntervalMinutes: interval, message: enabled ? 'PITR is configured. Run the selected schedule to create a baseline with binlog coordinates.' : 'Scheduled PITR capture is disabled.' };
  }

  startPitrRehearsal(input: PitrRehearsalDto) { return this.backups.startPitrRehearsal(input); }
  getPitrRehearsal(id: string) { return this.backups.getPitrRehearsal(id); }

  runbooks() {
    return [
      { id: 'failed-backup', title: 'A backup failed', steps: ['Open Backup history and read the failed process log.', 'Test the database connection and storage target.', 'Run the schedule manually and confirm the artifact is downloadable.', 'Create a restore test after the next successful run.'] },
      { id: 'restore', title: 'Restore a database safely', steps: ['Choose a verified backup and a dedicated recovery server.', 'Use Restore as a new database name for a rehearsal.', 'Verify application tables and row counts.', 'Only use overwrite after confirming a separate recovery point.'] },
      { id: 'pitr', title: 'Recover to a point in time', steps: ['Enable scheduled PITR for a full all-user-database baseline and a storage target.', 'Confirm binary-log retention exceeds the capture interval and watch for gaps.', 'Create a dedicated recovery-only connection using the same engine.', 'Run a rehearsal within the current continuous range and review checksum, verification, and cleanup evidence.'] },
      { id: 'ransomware', title: 'Suspected destructive event', steps: ['Stop scheduled writes if necessary and preserve logs.', 'Revoke delete-capable storage credentials.', 'Use an isolated destination for the first restore.', 'Record the selected recovery point and verification evidence.'] }
    ];
  }

  listFleet() { return (this.store.db.prepare('SELECT id,name,installation_id as installationId,status,last_seen_at as lastSeenAt,revoked_at as revokedAt,created_at as createdAt FROM fleet_servers ORDER BY name').all() as any[]); }
  enrollFleet(input: any) {
    const installationId = String(input.installationId || '').trim(); const token = String(input.token || '');
    if (!installationId || token.length < 16) throw new BadRequestException('A valid installation ID and one-time token are required');
    const id = crypto.randomUUID(); const hash = crypto.createHash('sha256').update(token).digest('hex');
    this.store.db.prepare('INSERT INTO fleet_servers (id,name,installation_id,enrollment_hash,status,created_at) VALUES (?,?,?,?,?,?)').run(id, String(input.name).trim(), installationId, hash, 'active', this.store.now());
    return { id, name: String(input.name).trim(), installationId, status: 'active', message: 'Server enrolled. The one-time token was not retained.' };
  }
  revokeFleet(id: string) { this.store.db.prepare("UPDATE fleet_servers SET status='revoked',revoked_at=? WHERE id=?").run(this.store.now(), id); return { ok: true }; }

  async runDue() {
    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const interrupted = this.store.db.prepare("SELECT id FROM recovery_tests WHERE status='running' AND started_at<?").all(cutoff) as any[];
    for (const test of interrupted) this.store.db.prepare("UPDATE recovery_tests SET status='failed',finished_at=?,error_message='Recovery test was interrupted before completion' WHERE id=?").run(this.store.now(), test.id);
    const plans = this.store.db.prepare("SELECT * FROM recovery_plans WHERE enabled=1 AND next_test_at IS NOT NULL AND next_test_at<=?").all(this.store.now()) as any[];
    for (const plan of plans) void this.runTest(plan.id).catch(() => undefined);
    const dueCaptures = this.store.db.prepare("SELECT connection_id as connectionId,storage_target_id as storageTargetId,capture_interval_minutes as captureIntervalMinutes FROM pitr_sources WHERE enabled=1 AND next_capture_at IS NOT NULL AND next_capture_at<=?").all(this.store.now()) as any[];
    for (const capture of dueCaptures) void this.backups.capturePitr(String(capture.connectionId), String(capture.storageTargetId), true).catch(() => undefined);
  }

  snapshot() { return { plans: this.listPlans(), tests: this.listTests(), policy: this.policy() }; }
  private publish() { this.realtime.publishThrottled('recovery_tests', this.snapshot(), 250); }
  private json(value: unknown) { try { return JSON.parse(String(value || '{}')); } catch { return {}; } }
  private planView(row: any) {
    const latest = this.store.db.prepare('SELECT * FROM recovery_tests WHERE plan_id=? ORDER BY started_at DESC LIMIT 1').get(row.id) as any;
    return { id: row.id, name: row.name, jobId: row.job_id, jobName: row.job_name, destinationConnectionId: row.destination_connection_id, recoveryConnectionId: row.destination_purpose === 'recovery' ? row.destination_connection_id : null, destinationName: row.destination_name, destinationPurpose: row.destination_purpose || 'backup', cronExpression: row.cron_expression, timezone: row.timezone, enabled: Boolean(row.enabled), testDatabasePrefix: row.test_database_prefix, lastTestAt: row.last_test_at, nextTestAt: row.next_test_at, lastStatus: row.last_status, lastMessage: row.last_message, latestTest: latest ? { id: latest.id, status: latest.status, startedAt: latest.started_at, finishedAt: latest.finished_at, rpoSeconds: latest.rpo_seconds, rtoSeconds: latest.rto_seconds, errorMessage: latest.error_message } : null };
  }
}
