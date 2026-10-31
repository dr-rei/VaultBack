import { nextCron } from '../src/backup/backup.utils';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../src/database/database.service';
import { ExecutionService } from '../src/backup/execution.service';
import { ExecutionStore } from '../src/backup/execution.store';
import { BackupService } from '../src/backup/backup.service';

describe('shared execution admission', () => {
  let database: DatabaseService; let store: ExecutionStore; let service: ExecutionService; let directory: string; let previous: string | undefined;
  const actor = { userId: 'admin' };
  beforeEach(async () => {
    previous = process.env.DATA_DIR; directory = fs.mkdtempSync(path.join(os.tmpdir(),'vaultback-results-')); process.env.DATA_DIR = directory;
    database = new DatabaseService(); await database.onModuleInit(); store = new ExecutionStore(database); service = new ExecutionService(store);
    const db = database.db; const now = database.now();
    db.prepare('INSERT INTO users(id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)').run('admin','admin','dummy','admin',now);
    for (let i=1;i<=3;i++) db.prepare('INSERT INTO database_connections(id,name,engine,host,port,username,password_enc,database_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(`c${i}`,`source${i}`,'mysql','localhost',3306,'u',database.encrypt('never-snapshot-secret'),'db',now);
    for (let i=1;i<=2;i++) db.prepare('INSERT INTO storage_targets(id,name,type,config_enc,created_at) VALUES (?,?,?,?,?)').run(`s${i}`,`target${i}`,'local',database.encrypt(JSON.stringify({ path: directory })),now);
    db.prepare('INSERT INTO backup_jobs(id,name,database_connection_id,storage_target_id,cron_expression,filename_prefix,created_at) VALUES (?,?,?,?,?,?,?)').run('j','job','c1','s1','0 0 * * *','backup',now);
    for (let i=1;i<=3;i++) db.prepare('INSERT INTO backup_job_connections(job_id,connection_id,database_names,position) VALUES (?,?,?,?)').run('j',`c${i}`,'["db"]',i);
    for (let i=1;i<=2;i++) db.prepare('INSERT INTO backup_job_storages(job_id,storage_target_id,position) VALUES (?,?,?)').run('j',`s${i}`,i);
  });
  afterEach(() => { database.onModuleDestroy(); if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; fs.rmSync(directory,{recursive:true,force:true}); });
  it('shares canonical host groups and releases slots during durable retry delay', async () => {
    database.db.prepare('UPDATE database_connections SET host=? WHERE id=?').run('LOCALHOST.','c2');
    const e = service.enqueue('j','manual',actor);
    expect(new Set(e.pairs.map(p => p.sourceGroupId)).size).toBe(1);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {release=resolve;});
    const executePair = jest.fn(async () => { await barrier; return {runId:'',status:'success',cleanupWarnings:[]}; });
    (service as any).executor = {executePair}; service.pump();
    await Promise.resolve(); expect(executePair).toHaveBeenCalledTimes(1);
    expect(service.get(e.id).pairs.filter(p => p.waitReason === 'source_capacity')).toHaveLength(5);
    release(); await service.drain();
  });
  it('persists retry delay and refuses early admission', () => {
    database.db.prepare('UPDATE backup_jobs SET retry_count=1,retry_delay_seconds=30').run();
    const e=service.enqueue('j','manual',actor); const context=store.startAttempt(e.pairs[0].id);
    store.finishAttempt(context,{runId:'',status:'failed',cleanupWarnings:[]});
    expect(service.get(e.id).pairs[0].status).toBe('retry_wait');
    expect(() => store.startAttempt(e.pairs[0].id)).toThrow('delay');
    database.db.prepare('UPDATE backup_execution_pairs SET next_attempt_at=? WHERE id=?').run('2000-01-01',e.pairs[0].id);
    const retry=store.startAttempt(e.pairs[0].id); expect(retry.attemptNumber).toBe(2);
    store.finishAttempt(retry,{runId:'',status:'failed',cleanupWarnings:[]});
    expect(service.get(e.id).pairs[0].status).toBe('failed');
  });
  it('rejects group reassignment with queued work and unauthorized limit changes', () => {
    service.enqueue('j','manual',actor);
    expect(() => service.assignGroup(['c1'],'alias','alias',2,actor)).toThrow('queued');
    expect(() => service.configure(32,{userId:'missing'})).toThrow('Administrator');
    expect(() => service.configure(33,actor)).toThrow();
  });
  it('includes execution and attempt links in artifact history responses', () => {
    database.db.prepare('INSERT INTO backup_runs(id,job_id,status,started_at,filename,execution_id,attempt_id) VALUES (?,?,?,?,?,?,?)').run('artifact','j','success',database.now(),'backup.sql','execution','attempt');
    const backups = Object.create(BackupService.prototype) as any;
    backups.store = database;
    expect(backups.runsPage().items[0]).toMatchObject({id:'artifact',executionId:'execution',attemptId:'attempt'});
    expect(backups.runsForJobPage('j').items[0]).toMatchObject({id:'artifact',executionId:'execution',attemptId:'attempt'});
  });
  it('replaces alias membership and returns removed sources to their automatic group with an audit', () => {
    service.assignGroup(['c1','c2'],'alias','Cluster',2,actor);
    service.assignGroup(['c1'],'alias','Cluster renamed',3,actor);
    expect((database.db.prepare('SELECT source_group_id FROM database_connections WHERE id=?').get('c2') as any).source_group_id).toBeNull();
    expect(service.sourceGroup('c2')).toBe('host:localhost:3306');
    expect(service.groups().items.find(group => group.id === 'alias')).toMatchObject({connectionIds:['c1'],concurrency:3});
    const events = database.db.prepare("SELECT actor_id,payload_json FROM execution_events WHERE kind='source_group_configured' ORDER BY rowid").all() as any[];
    expect(events).toHaveLength(2);
    expect(events[1].actor_id).toBe('admin');
    expect(JSON.parse(events[1].payload_json).removedConnectionIds).toEqual(['c2']);
  });
  it('rejects removing queued alias members atomically but permits unchanged membership tuning', () => {
    service.assignGroup(['c1','c2'],'alias','Cluster',2,actor);
    service.enqueue('j','manual',actor);
    expect(() => service.assignGroup(['c1'],'alias','Changed',4,actor)).toThrow('queued');
    expect(service.groups().items.find(group => group.id === 'alias')).toMatchObject({name:'Cluster',connectionIds:['c1','c2'],concurrency:2});
    service.assignGroup(['c1','c2'],'alias','Tuned',3,actor);
    expect(service.groups().items.find(group => group.id === 'alias')).toMatchObject({name:'Tuned',concurrency:3});
  });
  it('advances missed schedules once and leaves disabled schedules untouched', () => {
    database.db.prepare('UPDATE backup_jobs SET next_run_at=?,cron_expression=?').run('2026-10-01T00:00:00.000Z','0 0 * * *');
    jest.spyOn(database,'now').mockReturnValue('2026-10-03T12:00:00.000Z');
    service.runDue(true); service.runDue(true);
    const rows=database.db.prepare('SELECT * FROM backup_executions').all() as any[];
    expect(rows).toHaveLength(1); expect(rows[0].missed_count).toBe(3); expect(rows[0].trigger).toBe('catchup');
    database.db.prepare('UPDATE backup_jobs SET enabled=0,next_run_at=?').run('2026-10-01T00:00:00.000Z');
    service.runDue(true); expect(database.db.prepare('SELECT COUNT(*) as n FROM backup_executions').get()).toEqual({n:1});
  });
  it('uses monotonic real instants across DST gaps and repeated hours', () => {
    expect(nextCron('30 2 * * *',new Date('2026-03-08T06:59:00Z'),'America/New_York').toISOString()).toBe('2026-03-09T06:30:00.000Z');
    expect(nextCron('30 1 * * *',new Date('2026-11-01T05:30:00Z'),'America/New_York').toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });
  it('does not duplicate occurrences after a clock rollback', () => {
    database.db.prepare('UPDATE backup_jobs SET next_run_at=?,cron_expression=?').run('2026-10-03T00:00:00.000Z','0 0 * * *');
    const clock=jest.spyOn(database,'now').mockReturnValue('2026-10-03T12:00:00.000Z');
    service.runDue(); clock.mockReturnValue('2026-10-02T12:00:00.000Z'); service.runDue();
    expect(database.db.prepare('SELECT COUNT(*) as n FROM backup_executions').get()).toEqual({n:1});
  });
  it('limits global admissions across independent groups', async () => {
    database.db.prepare('UPDATE database_connections SET host=id').run();
    const e=service.enqueue('j','manual',actor); service.configure(2,actor);
    let release!: () => void; const barrier=new Promise<void>(resolve => {release=resolve;});
    const executePair=jest.fn(async () => {await barrier; return {runId:'',status:'success',cleanupWarnings:[]};});
    (service as any).executor={executePair}; service.pump(); await Promise.resolve();
    expect(executePair).toHaveBeenCalledTimes(2); expect(service.get(e.id).pairs.filter(p => p.status==='running')).toHaveLength(2);
    release(); await service.drain();
  });

  it('canonicalizes IPv6 spellings and honors explicit aliases', () => {
    database.db.prepare('UPDATE database_connections SET host=? WHERE id=?').run('[2001:0db8:0:0:0:0:0:1]','c1');
    database.db.prepare('UPDATE database_connections SET host=? WHERE id=?').run('2001:db8::1','c2');
    expect(service.sourceGroup('c1')).toBe(service.sourceGroup('c2'));
    service.assignGroup(['c1','c3'],'db-cluster','DB cluster',2,actor);
    expect(service.sourceGroup('c1')).toBe(service.sourceGroup('c3'));
  });
  it('recovers confirmed artifacts and marks unknown interrupted effects without rerunning', () => {
    const e=service.enqueue('j','manual',actor);
    const a=store.startAttempt(e.pairs[0].id); const b=store.startAttempt(e.pairs[1].id);
    database.db.prepare('INSERT INTO backup_runs(id,job_id,status,started_at,attempt_id) VALUES (?,?,?,?,?)').run('confirmed','j','success',database.now(),a.attemptId);
    service.recover();
    const view=service.get(e.id); expect(view.pairs[0].status).toBe('success'); expect(view.pairs[1].status).toBe('interrupted');
    expect(view.pairs[1].cleanupWarnings.join(' ')).toContain('remote effects are unknown');
    service.recover(); expect(service.get(e.id)).toEqual(view);
  });

  it('continues startup catchup when a schedule source has been deleted', () => {
    database.db.prepare('DELETE FROM database_connections WHERE id=?').run('c1');
    database.db.prepare('INSERT INTO backup_jobs(id,name,database_connection_id,storage_target_id,cron_expression,filename_prefix,created_at,next_run_at) VALUES (?,?,?,?,?,?,?,?)').run('healthy','healthy','c2','s1','0 0 * * *','backup',database.now(),'2026-10-03T00:00:00.000Z');
    database.db.prepare('UPDATE backup_jobs SET next_run_at=? WHERE id=?').run('2026-10-03T00:00:00.000Z','j');
    jest.spyOn(database,'now').mockReturnValue('2026-10-03T12:00:00.000Z');
    expect(() => service.runDue(true)).not.toThrow();
    expect(database.db.prepare('SELECT COUNT(*) as n FROM backup_executions').get()).toEqual({n:2});
    expect((database.db.prepare('SELECT source_group_id FROM backup_execution_pairs WHERE connection_id=?').get('c1') as any).source_group_id).toBe('missing:c1');
  });
  it('retries exactly one historical pair using recorded configuration', () => {
    database.db.prepare('UPDATE backup_jobs SET retry_count=2,retry_delay_seconds=47 WHERE id=?').run('j');
    const objects=JSON.stringify({views:true,routines:true,triggers:true,events:true});
    database.db.prepare('INSERT INTO backup_runs(id,job_id,status,started_at,database_connection_id,storage_target_id,database_scope,database_names,backup_layout,backup_objects,compression,backup_encryption,insert_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy','j','failed',database.now(),'c2','s2','selected','["historical"]','single',objects,'gzip','none','extended');
    const e=service.retryHistoricalRun('legacy',actor); expect(e.pairs).toHaveLength(1); expect(e.pairs[0].connectionId).toBe('c2'); expect(e.pairs[0].storageTargetId).toBe('s2');
    const context=store.startAttempt(e.pairs[0].id);
    expect(context.snapshot.database_names).toBe('["historical"]'); expect(context.snapshot.retry_count).toBe(2); expect(context.snapshot.retry_delay_seconds).toBe(47);
  });
  it('searches sparse and impossible schedules without minute timezone scans', () => {
    const start=performance.now();
    expect(nextCron('0 0 1 1 *',new Date('2026-01-02T00:00:00Z'),'UTC').toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(() => nextCron('0 0 31 2 *',new Date('2026-01-01T00:00:00Z'),'UTC')).toThrow();
    expect(performance.now()-start).toBeLessThan(500);
  });

});
