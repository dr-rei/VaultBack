import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ExecutionView, PairExecutionContext, PairOutcome } from './execution.types';
import crypto from 'node:crypto';

@Injectable()
export class ExecutionStore {
  constructor(readonly database: DatabaseService) {}
  get(id: string): ExecutionView {
    const db = this.database.db;
    const row = db.prepare('SELECT * FROM backup_executions WHERE id=?').get(id) as any;
    if (!row) throw new NotFoundException('Execution not found');
    const pairs = (db.prepare('SELECT * FROM backup_execution_pairs WHERE execution_id=? ORDER BY rowid').all(id) as any[]).map(pair => ({
      sourceName: (db.prepare('SELECT name FROM database_connections WHERE id=?').get(pair.connection_id) as any)?.name, targetName: (db.prepare('SELECT name FROM storage_targets WHERE id=?').get(pair.storage_target_id) as any)?.name,
      id: pair.id, connectionId: pair.connection_id, storageTargetId: pair.storage_target_id, fingerprint: pair.fingerprint,
      sourceGroupId: pair.source_group_id, required: Boolean(pair.required), status: pair.status, waitReason: pair.wait_reason,
      queuePosition: ['queued','retry_wait'].includes(pair.status) ? (this.readyPairs() as any[]).findIndex(p => p.id === pair.id) + 1 : null, cleanupWarnings: JSON.parse(pair.cleanup_warnings_json),
      attempts: (db.prepare('SELECT * FROM backup_execution_attempts WHERE pair_id=? ORDER BY attempt_number').all(pair.id) as any[]).map(a => ({ id: a.id, attemptNumber: a.attempt_number, status: a.status, runId: a.backup_run_id, startedAt: a.started_at, finishedAt: a.finished_at, failedStage: a.failed_stage, error: a.error_message, cleanupWarnings: JSON.parse(a.cleanup_warnings_json) }))
    }));
    return { jobName:(db.prepare('SELECT name FROM backup_jobs WHERE id=?').get(row.job_id) as any)?.name, id: row.id, jobId: row.job_id, trigger: row.trigger, status: row.status, scheduledFor: row.scheduled_for, queuedAt: row.queued_at, startedAt: row.started_at, finishedAt: row.finished_at, parentExecutionId: row.parent_execution_id, pairs, cleanupWarnings: JSON.parse(row.cleanup_warnings_json) };
  }
  readyPairs() {
    return this.database.db.prepare("SELECT p.id,p.execution_id as executionId,p.source_group_id as sourceGroupId,p.next_attempt_at as nextAttemptAt,e.priority,e.enqueue_sequence as enqueueSequence FROM backup_execution_pairs p JOIN backup_executions e ON e.id=p.execution_id WHERE p.status IN ('queued','retry_wait') AND e.status IN ('queued','running','retrying') ORDER BY e.priority DESC,e.enqueue_sequence,p.rowid").all();
  }
  private event(executionId: string, pairId: string, kind: string, payload: object) {
    this.database.db.prepare('INSERT INTO execution_events(id,execution_id,pair_id,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),executionId,pairId,kind,JSON.stringify(payload),this.database.now());
  }
  startAttempt(pairId: string): PairExecutionContext {
    return this.database.db.transaction(() => {
      const db = this.database.db;
      const pair = db.prepare('SELECT p.*,e.job_id,e.status as execution_status FROM backup_execution_pairs p JOIN backup_executions e ON e.id=p.execution_id WHERE p.id=?').get(pairId) as any;
      if (!pair) throw new NotFoundException('Execution pair not found');
      if (!['queued','running','retrying'].includes(pair.execution_status)) throw new Error('Execution is not eligible to start');
      if (pair.next_attempt_at && Date.parse(pair.next_attempt_at) > Date.parse(this.database.now())) throw new Error('Retry delay has not elapsed');
      if (pair.status !== 'queued' && pair.status !== 'retry_wait') throw new Error('Pair is not eligible to start');
      const attemptNumber = Number((db.prepare('SELECT MAX(attempt_number) as n FROM backup_execution_attempts WHERE pair_id=?').get(pairId) as any).n || 0) + 1;
      const attemptId = crypto.randomUUID(); const now = this.database.now();
      db.prepare('INSERT INTO backup_execution_attempts(id,pair_id,attempt_number,status,started_at) VALUES (?,?,?,?,?)').run(attemptId,pairId,attemptNumber,'running',now);
      db.prepare("UPDATE backup_execution_pairs SET status='running',started_at=COALESCE(started_at,?),wait_reason=NULL WHERE id=?").run(now,pairId);
      db.prepare("UPDATE backup_executions SET status='running',started_at=COALESCE(started_at,?) WHERE id=?").run(now,pair.execution_id);
      this.event(pair.execution_id,pairId,'attempt_started',{ attemptId,attemptNumber });
      return { executionId: pair.execution_id, pairId, attemptId, attemptNumber, jobId: pair.job_id, connectionId: pair.connection_id, storageTargetId: pair.storage_target_id, snapshot: JSON.parse(pair.snapshot_json) };
    });
  }
  requestCancellation(id: string, actorId: string) {
    this.database.db.transaction(() => {
      const view = this.get(id); const db = this.database.db; const now = this.database.now();
      if (!['queued','running','retrying','cancel_requested'].includes(view.status)) return;
      db.prepare("UPDATE backup_execution_pairs SET status='not_started',finished_at=?,next_attempt_at=NULL,wait_reason=NULL WHERE execution_id=? AND status IN ('queued','retry_wait')").run(now,id);
      db.prepare("UPDATE backup_execution_pairs SET status='cancel_requested' WHERE execution_id=? AND status='running'").run(id);
      const active = view.pairs.some(pair => ['running','cancel_requested'].includes(pair.status));
      db.prepare('UPDATE backup_executions SET status=?,finished_at=? WHERE id=?').run(active ? 'cancel_requested' : 'cancelled',active ? null : now,id);
      if (view.status !== 'cancel_requested') db.prepare('INSERT INTO execution_events(id,execution_id,kind,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),id,'cancel_requested',actorId,'{}',now);
    });
  }
  finishAttempt(context: PairExecutionContext, outcome: PairOutcome) {
    this.database.db.transaction(() => {
      const db = this.database.db; const now = this.database.now();
      const current = db.prepare('SELECT a.status,p.status as pair_status FROM backup_execution_attempts a JOIN backup_execution_pairs p ON p.id=a.pair_id WHERE a.id=? AND a.pair_id=?').get(context.attemptId,context.pairId) as any;
      if (!current || current.status !== 'running' || !['running','cancel_requested'].includes(current.pair_status)) return;
      const cancelling = current.pair_status === 'cancel_requested';
      if (cancelling && outcome.status !== 'success') outcome = { ...outcome, status: 'cancelled' };
      db.prepare('UPDATE backup_execution_attempts SET status=?,backup_run_id=?,finished_at=?,failed_stage=?,error_message=?,cleanup_warnings_json=? WHERE id=? AND status=?').run(outcome.status,outcome.runId,now,outcome.failedStage || null,outcome.error || null,JSON.stringify(outcome.cleanupWarnings),context.attemptId,'running');
      const retry = !cancelling && outcome.status === 'failed' && context.attemptNumber <= Number(context.snapshot.retry_count || 0);
      const next = retry ? new Date(Date.parse(now) + Math.max(0,Number(context.snapshot.retry_delay_seconds || 0)) * 1000).toISOString() : null;
      db.prepare('UPDATE backup_execution_pairs SET status=?,finished_at=?,next_attempt_at=?,wait_reason=?,cleanup_warnings_json=? WHERE id=?').run(retry ? 'retry_wait' : outcome.status,retry ? null : now,next,retry ? 'retry_delay' : null,JSON.stringify(outcome.cleanupWarnings),context.pairId);
      this.event(context.executionId,context.pairId,'attempt_finished',{ attemptId: context.attemptId,status: outcome.status,runId: outcome.runId });
      const view = this.get(context.executionId); const terminal = view.pairs.every(p => ['success','failed','cancelled','interrupted','not_started'].includes(p.status));
      const successes = view.pairs.filter(p => p.status === 'success').length;
      const status = view.status === 'cancel_requested' ? (terminal ? 'cancelled' : 'cancel_requested') : terminal ? successes === view.pairs.length ? 'success' : successes ? 'partial_failure' : view.pairs.some(p => p.status === 'failed') ? 'failed' : view.pairs.some(p => p.status === 'interrupted') ? 'interrupted' : 'failed' : view.pairs.some(p => p.status === 'running') ? 'running' : view.pairs.some(p => p.status === 'retry_wait') ? 'retrying' : 'queued';
      db.prepare('UPDATE backup_executions SET status=?,finished_at=?,cleanup_warnings_json=? WHERE id=?').run(status,terminal ? now : null,JSON.stringify([...new Set([...view.cleanupWarnings,...view.pairs.flatMap(p => p.cleanupWarnings)])]),context.executionId);
    });
  }
}
