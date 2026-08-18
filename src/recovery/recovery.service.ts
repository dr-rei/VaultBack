import { BadRequestException, Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { BackupService } from '../backup/backup.service';
import { StorageService } from '../storage/storage.service';
import { RealtimeService } from '../system/realtime.service';
import { nextCron, safeFilePart } from '../backup/backup.utils';

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
    const target = this.storage.get(String(run.storage_target_id || this.store.db.prepare('SELECT storage_target_id FROM backup_jobs WHERE id=?').get(plan.job_id)?.storage_target_id || ''));
    const available = await this.storage.isAvailable(target, String(run.filename), run.storage_location ? String(run.storage_location) : undefined, run.storage_folder ? String(run.storage_folder) : '');
    if (!available) throw new BadRequestException('The latest backup artifact is missing from its storage target');
    const started = Date.now();
    const testId = crypto.randomUUID();
    const suffix = crypto.randomBytes(5).toString('hex');
    const databaseName = `${String(plan.test_database_prefix || 'vaultback_recovery_test')}_${suffix}`.slice(0, 63);
    this.store.db.prepare('INSERT INTO recovery_tests (id,plan_id,source_run_id,status,started_at,test_database_name,destination_connection_id,evidence_json) VALUES (?,?,?,?,?,?,?,?)').run(testId, planId, run.id, 'running', this.store.now(), databaseName, plan.destination_connection_id, JSON.stringify({ sourceFilename: run.filename, sourceFinishedAt: run.finished_at || run.started_at }));
    this.publish();
    try {
      const result = await this.backups.restoreRunForRecoveryTest(String(run.id), String(plan.destination_connection_id), databaseName);
      const finished = Date.now();
      const rpo = Math.max(0, Math.round((finished - Date.parse(String(run.finished_at || run.started_at))) / 1000));
      const rto = Math.max(0, Math.round((finished - started) / 1000));
      const status = result.cleanupOk === false ? 'warning' : 'passed';
      const message = result.cleanupOk === false ? `Restore verified, but disposable database cleanup needs manual review: ${result.cleanupMessage}` : 'Backup restored, verified, and disposable database removed';
      this.store.db.prepare('UPDATE recovery_tests SET status=?,finished_at=?,rpo_seconds=?,rto_seconds=?,objects_expected=?,objects_restored=?,evidence_json=?,error_message=? WHERE id=?').run(status, this.store.now(), rpo, rto, 0, 0, JSON.stringify({ ...result.verification, sourceRunId: run.id, sourceFinishedAt: run.finished_at || run.started_at, cleanupOk: result.cleanupOk !== false }), status === 'warning' ? result.cleanupMessage : null, testId);
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
    const jobs = this.store.db.prepare('SELECT j.*,s.name as storage_name,s.type as storage_type FROM backup_jobs j LEFT JOIN storage_targets s ON s.id=j.storage_target_id ORDER BY j.name').all() as any[];
    const items = jobs.map(job => {
      const latest = this.store.db.prepare("SELECT * FROM backup_runs WHERE job_id=? AND status='success' ORDER BY COALESCE(finished_at,started_at) DESC LIMIT 1").get(job.id) as any;
      const age = latest ? Math.max(0, Math.round((now - Date.parse(String(latest.finished_at || latest.started_at))) / 1000)) : null;
      const findings: any[] = [];
      if (!latest) findings.push({ severity: 'critical', code: 'no_success', title: 'No successful recovery point', detail: 'Run this schedule manually and confirm the artifact is downloadable.' });
      else if (age !== null && age > 48 * 3600) findings.push({ severity: 'high', code: 'stale', title: 'Latest backup is stale', detail: `The latest successful artifact is ${Math.round(age / 3600)} hours old.` });
      const plan = this.store.db.prepare('SELECT * FROM recovery_plans WHERE job_id=? ORDER BY last_test_at DESC LIMIT 1').get(job.id) as any;
      if (!plan || !plan.last_status || !['passed', 'warning'].includes(plan.last_status)) findings.push({ severity: 'high', code: 'untested', title: 'Restore has not been proven', detail: 'Create a Recovery Assurance plan and run an isolated restore test.' });
      const immutability = job.storage_target_id ? this.storage.immutabilityStatus(String(job.storage_target_id)) : { providerEnforced: false, configured: false, message: 'No storage target is configured.' };
      if (!immutability.providerEnforced) findings.push({ severity: 'medium', code: 'immutability', title: immutability.configured ? 'Immutable protection needs verification' : 'Immutable protection is not configured', detail: immutability.message });
      return { jobId: job.id, jobName: job.name, storageName: job.storage_name, storageType: job.storage_type, latestBackupAt: latest?.finished_at || latest?.started_at || null, findings, risk: findings.some(item => item.severity === 'critical') ? 'critical' : findings.some(item => item.severity === 'high') ? 'high' : findings.length ? 'medium' : 'ready' };
    });
    return { generatedAt: this.store.now(), summary: { critical: items.filter(i => i.risk === 'critical').length, high: items.filter(i => i.risk === 'high').length, medium: items.filter(i => i.risk === 'medium').length, ready: items.filter(i => i.risk === 'ready').length }, items };
  }

  async pitrStatus() {
    const rows = this.store.db.prepare("SELECT id,name,engine,host FROM database_connections WHERE COALESCE(connection_purpose,'backup') <> 'recovery' ORDER BY name").all() as any[];
    const items = [];
    for (const row of rows) {
      try { const source = this.store.db.prepare('SELECT storage_target_id as storageTargetId,last_capture_at as lastCaptureAt,message FROM pitr_sources WHERE connection_id=?').get(row.id) as any; const artifactCount = Number((this.store.db.prepare("SELECT COUNT(*) as count FROM pitr_artifacts WHERE connection_id=? AND status='captured'").get(row.id) as any)?.count || 0); items.push({ connectionId: row.id, name: row.name, engine: row.engine, storageTargetId: source?.storageTargetId || null, lastCaptureAt: source?.lastCaptureAt || null, artifactCount, ...(await this.backups.inspectPitr(row.id)) }); }
      catch (error: any) { items.push({ connectionId: row.id, name: row.name, engine: row.engine, status: 'error', message: String(error?.message || error).slice(0, 300) }); }
    }
    return { checkedAt: this.store.now(), items };
  }
  capturePitr(connectionId: string, storageTargetId: string) { return this.backups.capturePitr(connectionId, storageTargetId); }

  runbooks() {
    return [
      { id: 'failed-backup', title: 'A backup failed', steps: ['Open Backup history and read the failed process log.', 'Test the database connection and storage target.', 'Run the schedule manually and confirm the artifact is downloadable.', 'Create a restore test after the next successful run.'] },
      { id: 'restore', title: 'Restore a database safely', steps: ['Choose a verified backup and a dedicated recovery server.', 'Use Restore as a new database name for a rehearsal.', 'Verify application tables and row counts.', 'Only use overwrite after confirming a separate recovery point.'] },
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
  }

  snapshot() { return { plans: this.listPlans(), tests: this.listTests(), policy: this.policy() }; }
  private publish() { this.realtime.publishThrottled('recovery_tests', this.snapshot(), 250); }
  private json(value: unknown) { try { return JSON.parse(String(value || '{}')); } catch { return {}; } }
  private planView(row: any) {
    const latest = this.store.db.prepare('SELECT * FROM recovery_tests WHERE plan_id=? ORDER BY started_at DESC LIMIT 1').get(row.id) as any;
    return { id: row.id, name: row.name, jobId: row.job_id, jobName: row.job_name, destinationConnectionId: row.destination_connection_id, recoveryConnectionId: row.destination_purpose === 'recovery' ? row.destination_connection_id : null, destinationName: row.destination_name, destinationPurpose: row.destination_purpose || 'backup', cronExpression: row.cron_expression, timezone: row.timezone, enabled: Boolean(row.enabled), testDatabasePrefix: row.test_database_prefix, lastTestAt: row.last_test_at, nextTestAt: row.next_test_at, lastStatus: row.last_status, lastMessage: row.last_message, latestTest: latest ? { id: latest.id, status: latest.status, startedAt: latest.started_at, finishedAt: latest.finished_at, rpoSeconds: latest.rpo_seconds, rtoSeconds: latest.rto_seconds, errorMessage: latest.error_message } : null };
  }
}
