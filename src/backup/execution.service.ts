import { snapshotConfiguration } from './execution.types';
import { BadRequestException, Injectable, NotFoundException, Optional, OnApplicationBootstrap } from '@nestjs/common';
import { BackupService } from './backup.service';
import { nextCron } from './backup.utils';
import crypto from 'node:crypto';
import { ExecutionStore } from './execution.store';
import { selectionFingerprint, ConfigurationSnapshot, ExecutionTrigger, ExecutionView, PairSelection, RequestActor } from './execution.types';

@Injectable()
export class ExecutionService implements OnApplicationBootstrap {
  private executor?: BackupService;
  private stopped = false;
  dispatchError: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private workers = new Map<string, { group: string; controller: AbortController; promise: Promise<void> }>();
  constructor(readonly store: ExecutionStore, @Optional() backups?: BackupService) {
    if (backups) { this.executor = backups; backups.registerCoordinator(this); store.database.registerBeforeClose(() => this.drain()); }
  }
  onApplicationBootstrap() { this.recover(); this.runDue(true); this.pump(); }
  async drain() { this.stopped = true; clearTimeout(this.timer); for (const worker of this.workers.values()) worker.controller.abort(Object.assign(new Error('Application shutting down'),{name:'ExecutionShutdownError'})); await Promise.allSettled([...this.workers.values()].map(w => w.promise)); }
  private setting(key: string, fallback: number) { const row = this.store.database.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as any; const number = row ? Number(row.value) : fallback; return Number.isFinite(number) ? number : fallback; }
  configure(limit: number, actor: RequestActor) { this.actor(actor,'manual'); if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new BadRequestException('Concurrency must be between 1 and 32'); this.store.database.db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('execution_concurrency',String(limit)); this.pump(); }
  sourceGroup(connectionId: string): string {
    const db = this.store.database.db;
    const source = db.prepare('SELECT host,port,source_group_id FROM database_connections WHERE id=?').get(connectionId) as any;
    if (!source) return `missing:${connectionId}`;
    if (source.source_group_id && !source.source_group_id.startsWith('host:')) return source.source_group_id;
    const {id,name} = this.automaticGroup(source);
    db.prepare('INSERT OR IGNORE INTO source_groups(id,name,created_at) VALUES (?,?,?)').run(id,name,this.store.database.now());
    db.prepare('UPDATE database_connections SET source_group_id=? WHERE id=?').run(id,connectionId); return id;
  }
  private automaticGroup(source: any) {
    let host = String(source.host).trim().toLowerCase().replace(/\.$/,'').replace(/^\[|\]$/g,'');
    if (host.includes(':')) { try { host = new URL(`http://[${host}]`).hostname.replace(/^\[|\]$/g,''); } catch {} }
    const name = `${host}:${Number(source.port) || 3306}`;
    return {id:`host:${name}`,name};
  }
  assignGroup(connectionIds: string[], groupId: string, name: string, concurrency: number, actor: RequestActor) {
    this.actor(actor,'manual'); if (!groupId || !name || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new BadRequestException('Invalid source group');
    const db = this.store.database.db;
    const automatic = groupId.startsWith('host:');
    if (automatic && connectionIds.some(id => { const source = db.prepare('SELECT host,port,source_group_id FROM database_connections WHERE id=?').get(id) as any; return !source || this.automaticGroup(source).id !== groupId || (source.source_group_id && !source.source_group_id.startsWith('host:')); })) throw new BadRequestException('Automatic source group membership cannot be reassigned');
    db.transaction(() => {
      const selected = new Set(connectionIds);
      const previous = (db.prepare('SELECT id FROM database_connections WHERE source_group_id=?').all(groupId) as any[]).map(row => String(row.id));
      const removed = automatic ? [] : previous.filter(id => !selected.has(id));
      const changed = [...removed];
      for (const id of connectionIds) {
        const source = db.prepare('SELECT source_group_id FROM database_connections WHERE id=?').get(id) as any;
        if (!source) throw new BadRequestException('Database connection not found');
        if (!automatic && source.source_group_id !== groupId) changed.push(id);
      }
      for (const id of changed) {
        if (db.prepare("SELECT id FROM backup_execution_pairs WHERE connection_id=? AND status IN ('queued','running','retry_wait','cancel_requested')").get(id)) throw new BadRequestException('Source has queued or running work');
      }
      db.prepare('INSERT INTO source_groups(id,name,concurrency,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,concurrency=excluded.concurrency').run(groupId,name,concurrency,this.store.database.now());
      for (const id of removed) db.prepare('UPDATE database_connections SET source_group_id=NULL WHERE id=?').run(id);
      for (const id of connectionIds) db.prepare('UPDATE database_connections SET source_group_id=? WHERE id=?').run(groupId,id);
      db.prepare('INSERT INTO execution_events(id,kind,actor_id,payload_json,created_at) VALUES (?,?,?,?,?)').run(crypto.randomUUID(),'source_group_configured',actor.userId,JSON.stringify({groupId,name,concurrency,connectionIds,removedConnectionIds:removed}),this.store.database.now());
    }); this.pump();
  }
  prioritize(id: string, priority: number, actor: RequestActor) {
    this.actor(actor,'manual'); if (!Number.isSafeInteger(priority)) throw new BadRequestException('Invalid priority');
    const db = this.store.database.db; db.transaction(() => {
      const current = this.get(id); if (current.status !== 'queued') throw new BadRequestException('Only queued executions can be prioritized');
      db.prepare('UPDATE backup_executions SET priority=? WHERE id=?').run(priority,id);
      db.prepare('INSERT INTO execution_events(id,execution_id,kind,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),id,'priority_changed',actor.userId,JSON.stringify({priority}),this.store.database.now());
    }); this.pump(); return this.get(id);
  }
  pump() {
    if (this.stopped || !this.executor) return;
    clearTimeout(this.timer);
    const db = this.store.database.db; const limit = Math.max(1,Math.min(32,this.setting('execution_concurrency',4))); const now = Date.parse(this.store.database.now());
    for (const pair of this.store.readyPairs() as any[]) {
      let reason: string | null = null;
      const count = [...this.workers.values()].filter(w => w.group === pair.sourceGroupId).length;
      const group = db.prepare('SELECT concurrency FROM source_groups WHERE id=?').get(pair.sourceGroupId) as any;
      if (pair.nextAttemptAt && Date.parse(pair.nextAttemptAt) > now) reason = 'retry_delay';
      else if (this.workers.size >= limit) reason = 'global_capacity';
      else if (count >= Math.min(limit,group?.concurrency || 1)) reason = 'source_capacity';
      db.prepare('UPDATE backup_execution_pairs SET wait_reason=? WHERE id=?').run(reason,pair.id);
      if (reason) continue;
      const context = this.store.startAttempt(pair.id); const controller = new AbortController();
      const promise = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return this.executor!.executePair(context,controller.signal); }).catch(error => ({runId: '',status: controller.signal.aborted && controller.signal.reason?.name !== 'ExecutionShutdownError' ? 'cancelled' as const : 'interrupted' as const,error: String(error?.message || error),cleanupWarnings: ['Attempt interrupted; remote effects may require inspection']})).then(outcome => { this.store.finishAttempt(context,outcome); }).catch(error => { this.dispatchError = `Execution persistence failed: ${String(error?.message || error)}`; this.stopped = true; clearTimeout(this.timer); console.error(this.dispatchError); }).finally(() => { this.workers.delete(pair.id); this.pump(); });
      this.workers.set(pair.id,{group: pair.sourceGroupId,controller,promise});
    }
    if ((this.store.readyPairs() as any[]).length) { this.timer = setTimeout(() => this.pump(),1000); this.timer.unref?.(); }
  }
  recover() {
    const db = this.store.database.db;
    for (const row of db.prepare("SELECT p.id,p.execution_id,p.connection_id FROM backup_execution_pairs p WHERE p.status IN ('queued','retry_wait') AND p.source_group_id LIKE 'connection:%'").all() as any[]) {
      try { db.prepare('UPDATE backup_execution_pairs SET source_group_id=? WHERE id=?').run(this.sourceGroup(row.connection_id),row.id); }
      catch { db.prepare("UPDATE backup_execution_pairs SET status='interrupted',finished_at=?,cleanup_warnings_json=? WHERE id=?").run(this.store.database.now(),JSON.stringify(['Source connection missing during queue recovery']),row.id); }
    }
    for (const row of db.prepare("SELECT a.*,p.execution_id,p.connection_id,p.storage_target_id,e.job_id,p.snapshot_json FROM backup_execution_attempts a JOIN backup_execution_pairs p ON p.id=a.pair_id JOIN backup_executions e ON e.id=p.execution_id WHERE a.status='running'").all() as any[]) {
      const run = db.prepare('SELECT id,status FROM backup_runs WHERE attempt_id=?').get(row.id) as any;
      this.store.finishAttempt({executionId:row.execution_id,pairId:row.pair_id,attemptId:row.id,attemptNumber:row.attempt_number,jobId:row.job_id,connectionId:row.connection_id,storageTargetId:row.storage_target_id,snapshot:JSON.parse(row.snapshot_json)}, {runId:run?.id || '',status:run?.status === 'success' ? 'success' : 'interrupted',cleanupWarnings:run?.status === 'success' ? [] : ['Application stopped during attempt; remote effects are unknown. Inspect destination before retrying.']});
    }
  }
  runDue(startup = false) {
    if (this.stopped) return;
    const db = this.store.database.db; const now = this.store.database.now();
    for (const job of db.prepare('SELECT * FROM backup_jobs WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at').all(now) as any[]) { try { db.transaction(() => {
      let occurrence = job.next_run_at; let count = 0; let last = occurrence;
      while (occurrence <= now && count < 10000) { count++; last = occurrence; occurrence = nextCron(job.cron_expression,new Date(occurrence),job.timezone || 'UTC').toISOString(); }
      const bounded = occurrence <= now;
      if (bounded) { last = now; occurrence = nextCron(job.cron_expression,new Date(now),job.timezone || 'UTC').toISOString(); }
      const active = db.prepare("SELECT id FROM backup_executions WHERE job_id=? AND status IN ('queued','running','retrying','cancel_requested')").get(job.id);
      if (!active || job.overlap_policy === 'queue') {
        const execution = this.enqueue(job.id,startup ? 'catchup' : 'scheduled',null,job.next_run_at);
        db.prepare('UPDATE backup_executions SET missed_count=?,missed_from=?,missed_to=? WHERE id=?').run(startup ? count : Math.max(0,count-1),startup || count > 1 ? job.next_run_at : null,startup || count > 1 ? last : null,execution.id);
        if (bounded) db.prepare('UPDATE backup_executions SET cleanup_warnings_json=? WHERE id=?').run(JSON.stringify(['Missed occurrence count is at least 10000; enumeration was bounded']),execution.id);
      } else db.prepare('INSERT INTO execution_events(id,execution_id,kind,payload_json,created_at) VALUES (?,?,?,?,?)').run(crypto.randomUUID(),(active as any).id,'overlap_skipped',JSON.stringify({from:job.next_run_at,to:last,count}),now);
      db.prepare('UPDATE backup_jobs SET next_run_at=? WHERE id=?').run(occurrence,job.id);
    }); } catch (error: any) {
      db.prepare('INSERT INTO execution_events(id,kind,payload_json,created_at) VALUES (?,?,?,?)').run(crypto.randomUUID(),'schedule_enqueue_failed',JSON.stringify({jobId:job.id,error:String(error?.message || error).slice(0,500)}),now);
    } } this.pump();
  }
  cancel(id: string, actor: RequestActor, stopRunningConfirmed = false): ExecutionView {
    this.actor(actor, 'manual');
    const view = this.get(id);
    if (view.pairs.some(pair => pair.status === 'running') && !stopRunningConfirmed) throw new BadRequestException('Confirm stopping running work');
    this.store.requestCancellation(id, actor.userId);
    for (const pair of view.pairs) this.workers.get(pair.id)?.controller.abort(new Error('Execution cancelled by administrator'));
    this.pump();
    return this.get(id);
  }
  get(id: string) { return this.store.get(id); }
  list(query: any = {}) {
    const page = query.page === undefined || query.page === '' ? 1 : Number(query.page);
    const requestedSize = query.pageSize === undefined || query.pageSize === '' ? 25 : Number(query.pageSize);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(requestedSize) || requestedSize < 1) throw new BadRequestException('Invalid execution pagination');
    const pageSize = Math.min(100,requestedSize);
    const offset = (page-1)*pageSize;
    if (!Number.isSafeInteger(offset)) throw new BadRequestException('Invalid execution pagination');
    const conditions: string[] = []; const values: string[] = [];
    if (query.status) { conditions.push('status=?'); values.push(String(query.status)); }
    if (query.jobId) { conditions.push('job_id=?'); values.push(String(query.jobId)); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const db = this.store.database.db;
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM backup_executions${where}`).get(...values) as any).n);
    const items = (db.prepare(`SELECT id FROM backup_executions${where} ORDER BY enqueue_sequence DESC LIMIT ? OFFSET ?`).all(...values,pageSize,offset) as any[]).map(row => this.get(row.id));
    return {items,total,page,pageSize,pageCount:Math.max(1,Math.ceil(total/pageSize))};
  }
  groups() {
    const db = this.store.database.db; const globalConcurrency = this.setting('execution_concurrency',4);
    const groups = new Map<string,any>((db.prepare('SELECT id,name,concurrency FROM source_groups ORDER BY name,id').all() as any[]).map(group => [group.id,{...group,connectionIds:[]}]));
    for (const source of db.prepare('SELECT id,host,port,source_group_id FROM database_connections ORDER BY id').all() as any[]) {
      const automatic = this.automaticGroup(source);
      const id = source.source_group_id && !source.source_group_id.startsWith('host:') ? source.source_group_id : automatic.id;
      if (!groups.has(id)) groups.set(id,{id,name:automatic.name,concurrency:1,connectionIds:[]});
      groups.get(id).connectionIds.push(source.id);
    }
    const items = [...groups.values()].map(group => ({...group,effectiveConcurrency:Math.min(globalConcurrency,group.concurrency)}));
    return {items,globalConcurrency,dispatchError:this.dispatchError};
  }
  moveAhead(id: string, actor: RequestActor) {
    const row = this.store.database.db.prepare('SELECT MAX(priority) AS n FROM backup_executions').get() as any;
    return this.prioritize(id,Number(row.n || 0)+1,actor);
  }
  audit(id: string) { this.get(id); return this.store.database.db.prepare('SELECT kind,actor_id AS actorId,payload_json AS payloadJson,created_at AS createdAt FROM execution_events WHERE execution_id=? ORDER BY created_at,rowid').all(id); }
  async waitForTerminal(id: string, signal?: AbortSignal): Promise<ExecutionView> {
    while (true) {
      signal?.throwIfAborted();
      const view = this.get(id);
      if (!['queued','running','retrying','cancel_requested'].includes(view.status)) return view;
      if (this.stopped) throw new Error(this.dispatchError || 'Execution coordinator stopped before completion');
      await new Promise<void>((resolve,reject) => {
        const finish = () => { signal?.removeEventListener('abort',abort); resolve(); };
        const timer = setTimeout(finish,100);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort',abort); reject(signal?.reason || new Error('Request disconnected')); };
        signal?.addEventListener('abort',abort,{once:true});
      });
    }
  }
  private actor(actor: RequestActor | null, trigger: ExecutionTrigger) {
    if (trigger === 'manual' || trigger === 'retry') {
      const user = actor && this.store.database.db.prepare('SELECT role FROM users WHERE id=?').get(actor.userId) as any;
      if (!user || user.role !== 'admin') throw new BadRequestException('Administrator required');
    }
  }
  enqueue(jobId: string, trigger: ExecutionTrigger, actor: RequestActor | null, scheduledFor?: string): ExecutionView {
    this.actor(actor, trigger);
    const db = this.store.database.db;
    return db.transaction(() => {
      const job = db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(jobId) as any;
      if (!job) throw new NotFoundException('Backup schedule not found');
      const connections = db.prepare('SELECT connection_id,database_names FROM backup_job_connections WHERE job_id=? ORDER BY position,connection_id').all(jobId) as any[];
      const targets = db.prepare('SELECT storage_target_id,required FROM backup_job_storages WHERE job_id=? ORDER BY position,storage_target_id').all(jobId) as any[];
      if (!connections.length) connections.push({ connection_id: job.database_connection_id, database_names: job.database_names });
      if (!targets.length) targets.push({ storage_target_id: job.storage_target_id, required: 1 });
      const snapshots = connections.flatMap(connection => targets.map(target => {
        const source = db.prepare('SELECT database_names,database_name,source_group_id FROM database_connections WHERE id=?').get(connection.connection_id) as any;
        const pitr = db.prepare('SELECT enabled,base_job_id FROM pitr_sources WHERE connection_id=?').get(connection.connection_id) as any;
        const snapshot = snapshotConfiguration(job, connection.database_names, source, Boolean(pitr?.enabled && pitr.base_job_id === jobId));
        return { connectionId: connection.connection_id, storageTargetId: target.storage_target_id, required: target.required !== 0, sourceGroupId: this.sourceGroup(connection.connection_id), snapshot };
      }));
      return this.insert(jobId,trigger,actor,scheduledFor || null,null,snapshots);
    });
  }
  retry(id: string, pairs: PairSelection[], actor: RequestActor): ExecutionView {
    this.actor(actor,'retry');
    return this.store.database.db.transaction(() => {
      const parent = this.get(id);
      if (!pairs.length || new Set(pairs.map(p => JSON.stringify([p.connectionId,p.storageTargetId]))).size !== pairs.length) throw new BadRequestException('Select unique execution pairs');
      const selections = pairs.map(selection => {
        const pair = parent.pairs.find(p => p.connectionId === selection.connectionId && p.storageTargetId === selection.storageTargetId);
        if (!pair || (!['success','failed','cancelled','interrupted'].includes(pair.status) && !(pair.status === 'not_started' && ['success','partial_failure','failed','cancelled','interrupted'].includes(parent.status)))) throw new BadRequestException('Selected pair is unrelated or still active');
        const row = this.store.database.db.prepare('SELECT snapshot_json FROM backup_execution_pairs WHERE id=?').get(pair.id) as any;
        return { ...selection, required: pair.required, sourceGroupId: this.sourceGroup(pair.connectionId), snapshot: JSON.parse(row.snapshot_json) };
      });
      return this.insert(parent.jobId,'retry',actor,null,id,selections);
    });
  }
  retryHistoricalRun(runId: string, actor: RequestActor): ExecutionView {
    this.actor(actor,'retry');
    return this.store.database.db.transaction(() => {
      const db = this.store.database.db;
      const run = db.prepare('SELECT * FROM backup_runs WHERE id=?').get(runId) as any;
      if (!run || !['failed','retrying'].includes(run.status)) throw new BadRequestException('Only a failed backup run can be retried');
      const required = ['database_connection_id','storage_target_id','database_scope','database_names','backup_layout','backup_objects','compression','backup_encryption','insert_mode'];
      if (required.some(key => run[key] === null || run[key] === undefined)) throw new BadRequestException('Historical backup configuration is incomplete; start its schedule to create a new execution');
      const job = db.prepare('SELECT * FROM backup_jobs WHERE id=?').get(run.job_id) as any;
      if (!job) throw new BadRequestException('Historical backup schedule no longer exists');
      let names: unknown; let objects: any;
      try { names = JSON.parse(run.database_names); objects = JSON.parse(run.backup_objects); } catch { throw new BadRequestException('Historical backup configuration is invalid'); }
      if (!Array.isArray(names) || names.some(name => typeof name !== 'string') || !['selected','all'].includes(run.database_scope) || !['single','database','table'].includes(run.backup_layout) || !['none','gzip','zip'].includes(run.compression) || !['none','aes-256-gcm'].includes(run.backup_encryption) || !['extended','single-row'].includes(run.insert_mode) || !objects || ['views','routines','triggers','events'].some(key => typeof objects[key] !== 'boolean')) throw new BadRequestException('Historical backup configuration cannot be verified');
      const snapshot: ConfigurationSnapshot = {name:job.name,database_scope:run.database_scope,database_names:run.database_names,backup_layout:run.backup_layout,backup_objects:objects,insert_mode:run.insert_mode,compression:run.compression,backup_encryption:run.backup_encryption,filename_prefix:job.filename_prefix,retention_count:job.retention_count,retry_count:job.retry_count,retry_delay_seconds:job.retry_delay_seconds,recordPitrCoordinates:false};
      const execution = this.insert(run.job_id,'retry',actor,null,null,[{connectionId:run.database_connection_id,storageTargetId:run.storage_target_id,required:true,sourceGroupId:this.sourceGroup(run.database_connection_id),snapshot}]);
      db.prepare('INSERT INTO execution_events(id,execution_id,kind,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),execution.id,'historical_run_retry',actor.userId,JSON.stringify({runId}),this.store.database.now());
      return execution;
    });
  }
  private insert(jobId: string, trigger: ExecutionTrigger, actor: RequestActor | null, scheduledFor: string | null, parent: string | null, pairs: Array<PairSelection & {required: boolean; sourceGroupId: string; snapshot: ConfigurationSnapshot}>): ExecutionView {
    const db = this.store.database.db; const id = crypto.randomUUID(); const now = this.store.database.now();
    if (scheduledFor) { const existing = db.prepare('SELECT id FROM backup_executions WHERE job_id=? AND scheduled_for=?').get(jobId,scheduledFor) as any; if (existing) return this.get(existing.id); }
    const sequence = Number((db.prepare('SELECT MAX(enqueue_sequence) as n FROM backup_executions').get() as any).n || 0) + 1;
    db.prepare('INSERT INTO backup_executions(id,job_id,trigger,status,scheduled_for,queued_at,parent_execution_id,actor_id,enqueue_sequence,snapshot_json) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,jobId,trigger,'queued',scheduledFor,now,parent,actor?.userId || null,sequence,JSON.stringify({ version: 1 }));
    for (const pair of pairs) {
      const s = pair.snapshot;
      const fingerprint = selectionFingerprint(s);
      db.prepare('INSERT INTO backup_execution_pairs(id,execution_id,connection_id,storage_target_id,fingerprint,source_group_id,required,snapshot_json) VALUES (?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),id,pair.connectionId,pair.storageTargetId,fingerprint,pair.sourceGroupId,pair.required ? 1 : 0,JSON.stringify(s));
    }
    db.prepare('INSERT INTO execution_events(id,execution_id,kind,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),id,'enqueued',actor?.userId || null,JSON.stringify({ trigger,parentExecutionId: parent }),now);
    queueMicrotask(() => this.pump());
    return this.get(id);
  }
}
