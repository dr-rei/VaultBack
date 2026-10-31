import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { NotificationEvent, SystemService } from './system.service';

export interface ExecutionNotification {
  eventId: string; executionId?: string; incidentId?: string;
  kind: 'first_failure' | 'recovered' | 'final_failure' | 'success' | 'missed_start' | 'stale' | 'long_running';
  pairs: { connectionId: string; storageTargetId: string; required?: boolean; status?: string }[];
  message: string; preference?: NotificationEvent;
}

/** Durable event IDs deduplicate local intent. Delivery is at least once: a crash
 * after a provider accepts a request but before the receipt commits can resend it. */
@Injectable()
export class NotificationOutboxService implements OnApplicationBootstrap {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  lastPollError: string | null = null;
  private active?: Promise<void>;
  constructor(private readonly database: DatabaseService, private readonly system: SystemService) {
    database.registerBeforeClose(() => this.stop());
  }
  onApplicationBootstrap() { this.poll(); }
  private poll() {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.poll(),1000); this.timer.unref?.();
    void this.deliverDue(new Date()).then(() => { this.lastPollError = null; }).catch(() => { this.lastPollError = 'Notification delivery loop failed; durable events remain pending.'; });
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.active; }
  record(event: ExecutionNotification) {
    const preference = event.preference || (event.kind === 'first_failure' || event.kind === 'final_failure' ? 'backup_failed' : event.kind === 'recovered' ? 'backup_recovered' : event.kind === 'success' ? 'backup_success' : event.kind === 'stale' ? 'backup_stale' : event.kind === 'missed_start' ? 'backup_missed_start' : 'backup_long_running');
    this.database.db.prepare('INSERT OR IGNORE INTO notification_outbox(id,event_id,execution_id,incident_id,kind,payload_json,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(event.eventId,event.eventId,event.executionId || null,event.incidentId || null,event.kind,JSON.stringify({...event,preference}),this.database.now(),this.database.now());
  }
  materialize() {
    const db = this.database.db;
    db.transaction(() => {
      const cursor = Number((db.prepare('SELECT value FROM app_settings WHERE key=?').get('notification_event_cursor') as any)?.value || 0);
      const events = db.prepare('SELECT rowid as sequence,* FROM execution_events WHERE rowid>? ORDER BY rowid LIMIT 250').all(cursor) as any[];
      for (const event of events) {
        try {
          if (event.execution_id) this.execution(event.execution_id);
          if (['protection_incident_resolved','protection_incident_closed'].includes(event.kind)) {
            const payload = JSON.parse(event.payload_json);
            db.prepare("UPDATE notification_outbox SET status='superseded' WHERE incident_id=? AND status='pending'").run(payload.incidentId);
          }
          if (['protection_incident_opened','protection_incident_resolved'].includes(event.kind)) {
            const payload = JSON.parse(event.payload_json); const a = payload.assessment;
            const incident = db.prepare('SELECT kind FROM protection_incidents WHERE id=?').get(payload.incidentId) as any;
            const kind = a.kind || incident?.kind;
            const resolved = event.kind === 'protection_incident_resolved';
            const message = resolved ? kind === 'freshness' ? 'Verified protection is fresh.' : kind === 'missed_start' ? 'Previously delayed work started.' : 'Long-running work ended; inspect its outcome.' : kind === 'freshness' ? 'Verified protection is stale.' : kind === 'missed_start' ? 'Scheduled work has not started.' : 'Backup work is running longer than expected.';
            const job = db.prepare('SELECT name FROM backup_jobs WHERE id=?').get(a.jobId) as any;
            const source = db.prepare('SELECT name FROM database_connections WHERE id=?').get(a.connectionId) as any;
            const destination = db.prepare('SELECT name FROM storage_targets WHERE id=?').get(a.storageTargetId) as any;
            this.record({eventId:event.id,incidentId:payload.incidentId,kind:kind === 'freshness' ? 'stale' : kind,pairs:[{connectionId:a.connectionId,storageTargetId:a.storageTargetId}],message:`${message} Schedule ${String(job?.name || a.jobId).slice(0,120)}; ${String(source?.name || a.connectionId).slice(0,120)} -> ${String(destination?.name || a.storageTargetId).slice(0,120)}.`});
          }
        } catch {
          db.prepare("INSERT OR IGNORE INTO notification_outbox(id,event_id,kind,payload_json,status,next_attempt_at,last_error,created_at) VALUES (?,?,?,'{}','exhausted',?,?,?)").run(`invalid:${event.id}`,event.id,'invalid_event',this.database.now(),'Invalid persisted notification event',this.database.now());
        }
      }
      if (events.length) db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('notification_event_cursor',String(events[events.length - 1].sequence));
    });
  }
  private execution(id: string) {
    const db = this.database.db; const execution = db.prepare('SELECT * FROM backup_executions WHERE id=?').get(id) as any;
    if (!execution) return;
    const pairs = (db.prepare('SELECT p.connection_id as connectionId,p.storage_target_id as storageTargetId,p.required,p.status,p.snapshot_json as snapshotJson,c.name as sourceName,s.name as destinationName FROM backup_execution_pairs p LEFT JOIN database_connections c ON c.id=p.connection_id LEFT JOIN storage_targets s ON s.id=p.storage_target_id WHERE p.execution_id=?').all(id) as any[]).map(p => ({...p,required:Boolean(p.required)}));
    const failed = db.prepare("SELECT DISTINCT p.id FROM backup_execution_attempts a JOIN backup_execution_pairs p ON p.id=a.pair_id WHERE p.execution_id=? AND a.status='failed'").all(id);
    const terminal = ['failed','partial_failure','interrupted','success','cancelled'].includes(execution.status);
    const snapshot = pairs.length ? JSON.parse(pairs[0].snapshotJson) : {};
    const jobName = String(snapshot.name || execution.job_id).slice(0,120);
    const scope = execution.parent_execution_id ? `Schedule ${jobName}, selected-pair retry ${id} from parent ${execution.parent_execution_id}` : `Schedule ${jobName}, execution ${id}`;
    const labels = pairs.map(p => {
      const config = JSON.parse(p.snapshotJson);
      const databases = config.database_scope === 'all' ? 'all databases' : String(JSON.parse(config.database_names || '[]').join(', ')).slice(0,120);
      return `${String(p.sourceName || p.connectionId).slice(0,80)} [${databases}] -> ${String(p.destinationName || p.storageTargetId).slice(0,80)} (${p.required ? 'required' : 'optional'}: ${p.status})`;
    });
    const shown: string[] = []; let size = 0;
    for (const label of labels) { if (size + label.length > 1200) break; shown.push(label); size += label.length + 2; }
    const summary = shown.join('; ') + (shown.length < labels.length ? `; ${labels.length - shown.length} more pairs; inspect execution details.` : '');
    const add = (kind: ExecutionNotification['kind'], message: string) => this.record({eventId:`execution:${id}:${kind}`,executionId:id,kind,pairs:pairs.map(({connectionId,storageTargetId,required,status}) => ({connectionId,storageTargetId,required,status})),message:`${scope}: ${message} ${summary}`});
    if (!terminal && failed.length) add('first_failure','Backup attempt failed; automatic retries may still be pending.');
    if (terminal) db.prepare("UPDATE notification_outbox SET status='superseded' WHERE event_id=? AND status='pending'").run(`execution:${id}:first_failure`);
    if (terminal && execution.status !== 'cancelled') {
      if (execution.status === 'success') add(failed.length || execution.parent_execution_id ? 'recovered' : 'success',execution.parent_execution_id ? 'Selected pairs completed successfully; inspect the parent for other outcomes.' : failed.length ? 'Automatic retry recovered all execution pairs.' : 'Backup completed successfully.');
      else add('final_failure','Backup finished with unsuccessful pairs; inspect required and optional outcomes.');
    }
    // Keep one grouped first-failure payload current as additional pairs fail.
    if (failed.length) db.prepare("UPDATE notification_outbox SET payload_json=? WHERE event_id=? AND status='pending'").run(JSON.stringify({eventId:`execution:${id}:first_failure`,executionId:id,kind:'first_failure',pairs:pairs.map(({connectionId,storageTargetId,required,status}) => ({connectionId,storageTargetId,required,status})),message:`${scope}: Backup attempt failed. ${summary}`,preference:'backup_failed'}),`execution:${id}:first_failure`);
  }
  deliverDue(now: Date): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // Materialization keeps its one-second cadence even while a slow provider
    // is serving the sole delivery worker.
    try { this.materialize(); } catch (error) { return Promise.reject(error); }
    if (this.active) return this.active;
    this.active = this.flush(now).finally(() => { this.active = undefined; });
    return this.active;
  }
  private async flush(now: Date): Promise<void> {
    const db = this.database.db;
    const started = Date.now();
    const completionTime = () => new Date(now.getTime() + Math.max(0,Date.now() - started));
    const rows = db.prepare("SELECT * FROM notification_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at,rowid LIMIT 25").all(now.toISOString()) as any[];
    for (const row of rows) {
      if (this.stopped) break;
      const current = db.prepare('SELECT status,payload_json FROM notification_outbox WHERE id=?').get(row.id) as any;
      if (current?.status !== 'pending') continue;
      const payload = JSON.parse(current.payload_json);
      if (!this.system.notificationEnabled(payload.preference)) {
        db.prepare("UPDATE notification_outbox SET status='suppressed' WHERE id=?").run(row.id); continue;
      }
      try {
        await this.system.sendNotification(payload.preference,payload.message);
        db.prepare("UPDATE notification_outbox SET status='delivered',attempts=attempts+1,delivered_at=?,last_error=NULL WHERE id=?").run(completionTime().toISOString(),row.id);
      } catch (error: any) {
        const attempts = row.attempts + 1;
        // Provider response bodies and request URLs can contain credentials. Store
        // only adapter-owned classifications, never arbitrary provider exceptions.
        const message = /^Notification provider returned HTTP \d{3}$/.test(error?.message) ? error.message : error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Notification delivery timed out' : 'Notification delivery failed';
        const delay = [1,5,15,60][Math.min(attempts - 1,3)] * 60000;
        db.prepare("UPDATE notification_outbox SET status=?,attempts=?,next_attempt_at=?,last_error=? WHERE id=? AND status='pending'").run(attempts >= 5 ? 'exhausted' : 'pending',attempts,new Date(completionTime().getTime() + delay).toISOString(),message,row.id);
      }
    }
  }
  list() { return this.database.db.prepare('SELECT id,execution_id as executionId,incident_id as incidentId,kind,status,attempts,next_attempt_at as nextAttemptAt,delivered_at as deliveredAt,last_error as lastError,created_at as createdAt FROM notification_outbox ORDER BY created_at DESC LIMIT 100').all(); }
}
