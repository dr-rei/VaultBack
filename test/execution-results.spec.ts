import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../src/database/database.service';
import { ExecutionService } from '../src/backup/execution.service';
import { ExecutionStore } from '../src/backup/execution.store';
import { BackupService } from '../src/backup/backup.service';

describe('durable execution results', () => {
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
  it.each(['Infinity','1e309','9007199254740992','1.5','-1'])('rejects unsafe pagination %s before SQLite', page => {
    expect(() => service.list({page})).toThrow('Invalid execution pagination');
  });
  it('rejects unsafe page offsets and sizes', () => {
    expect(() => service.list({page:Number.MAX_SAFE_INTEGER,pageSize:100})).toThrow('Invalid execution pagination');
    expect(() => service.list({pageSize:'Infinity'})).toThrow('Invalid execution pagination');
    expect(service.list({page:1,pageSize:500})).toMatchObject({page:1,pageSize:100});
  });
  it('retries explicitly selected not-started pairs after queued cancellation', () => {
    const execution = service.enqueue('j','manual',actor);
    const cancelled = service.cancel(execution.id,actor);
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.pairs.every(pair => pair.status === 'not_started')).toBe(true);
    const retry = service.retry(execution.id,[{connectionId:'c1',storageTargetId:'s1'}],actor);
    expect(retry.pairs).toHaveLength(1); expect(retry.parentExecutionId).toBe(execution.id);
    expect(() => service.retry(retry.id,[{connectionId:'c1',storageTargetId:'s1'}],actor)).toThrow('still active');
  });
  it('lists automatic source groups without writes and permits tuning while work is queued', () => {
    const before = database.db.prepare('SELECT COUNT(*) AS n FROM source_groups').get() as any;
    const groups = service.groups(); expect(groups.items[0].connectionIds).toEqual(['c1','c2','c3']);
    expect(database.db.prepare('SELECT COUNT(*) AS n FROM source_groups').get()).toEqual(before);
    service.enqueue('j','manual',actor);
    service.assignGroup(['c1','c2','c3'],groups.items[0].id,'Shared database host',2,actor);
    expect(service.groups().items[0].concurrency).toBe(2);
    expect(() => service.assignGroup(['c1'],'alias','Alias',1,actor)).toThrow('queued or running');
  });
  it('creates six unique pairs, aggregates partial failure and retries only selected original configuration', () => {
    const execution = service.enqueue('j','manual',actor); expect(execution.pairs).toHaveLength(6);
    expect(new Set(execution.pairs.map(p => `${p.connectionId}/${p.storageTargetId}`)).size).toBe(6);
    for (const [index,pair] of execution.pairs.entries()) {
      const context = store.startAttempt(pair.id);
      store.finishAttempt(context,{runId:`artifact${index}`,status:index === 5 ? 'failed' : 'success',cleanupWarnings:[],error:index === 5 ? 'upload failed' : undefined});
    }
    expect(service.get(execution.id).status).toBe('partial_failure');
    const before = service.get(execution.id); database.db.prepare('UPDATE backup_jobs SET compression=?,filename_prefix=? WHERE id=?').run('none','edited','j');
    const retry = service.retry(execution.id,[execution.pairs[5]],actor);
    expect(retry.parentExecutionId).toBe(execution.id); expect(retry.pairs).toHaveLength(1);
    expect(store.startAttempt(retry.pairs[0].id).snapshot.filename_prefix).toBe('backup');
    expect(service.get(execution.id)).toEqual(before);
    const rows = database.db.prepare('SELECT snapshot_json FROM backup_execution_pairs').all(); expect(JSON.stringify(rows)).not.toContain('never-snapshot-secret'); expect(JSON.stringify(rows)).not.toContain('password');
  });
  it('rejects unauthorized, duplicate and unrelated selections and persists schedule occurrence identity', () => {
    expect(() => service.enqueue('j','manual',{userId:'missing'})).toThrow('Administrator');
    const e = service.enqueue('j','scheduled',null,'2026-01-01T00:00:00.000Z');
    expect(service.enqueue('j','scheduled',null,'2026-01-01T00:00:00.000Z').id).toBe(e.id);
    expect(() => service.retry(e.id,[{connectionId:'other',storageTargetId:'s1'}],actor)).toThrow();
    expect(() => service.retry(e.id,[e.pairs[0],e.pairs[0]],actor)).toThrow();
  });
  it.each(['retention failure','post-upload cancellation'])('preserves confirmed artifact after %s', async mode => {
    const e = service.enqueue('j','manual',actor); const context = store.startAttempt(e.pairs[0].id);
    const controller = new AbortController();
    const storage = {
      get: jest.fn(() => ({id:'s1'})),
      upload: jest.fn(async () => { if (mode === 'post-upload cancellation') controller.abort(new Error('stopped')); return {location:'confirmed-location'}; }),
      rotate: jest.fn(async () => {
        expect(database.db.prepare('SELECT status,storage_location FROM backup_runs WHERE attempt_id=?').get(context.attemptId)).toEqual({status:'success',storage_location:'confirmed-location'});
        throw new Error('provider retention unavailable');
      })
    };
    const notify = jest.fn(); const adapter = new BackupService(database,storage as any,{notify} as any,{publish:jest.fn(),publishThrottled:jest.fn()} as any);
    jest.spyOn(adapter as any,'listAvailableTables').mockResolvedValue({tables:['table'],views:[]});
    jest.spyOn(adapter as any,'dump').mockImplementation(async (...args: any[]) => { fs.writeFileSync(args[1],'-- MySQL dump\nCREATE TABLE table (id INT);'); });
    const outcome = await adapter.executePair(context,controller.signal); store.finishAttempt(context,outcome);
    expect(outcome.status).toBe('success'); expect(outcome.cleanupWarnings).toHaveLength(1);
    expect(database.db.prepare('SELECT status,storage_location FROM backup_runs WHERE id=?').get(outcome.runId)).toEqual({status:'success',storage_location:'confirmed-location'});
    expect(notify).not.toHaveBeenCalled();
    expect(store.get(e.id).pairs[0].attempts[0].cleanupWarnings).toHaveLength(1);
    store.finishAttempt(context,{runId:'late',status:'failed',cleanupWarnings:[]});
    expect(store.get(e.id).pairs[0].status).toBe('success');
  });
  it.each(['source','target','job'])('records failed pair identity when %s reference was deleted', async reference => {
    const e = service.enqueue('j','manual',actor); const context = store.startAttempt(e.pairs[0].id);
    const adapter = new BackupService(database,{get: jest.fn(() => { if (reference === 'target') throw new Error('Storage target not found'); return {id:'s1'}; })} as any,{} as any,{publish:jest.fn(),publishThrottled:jest.fn()} as any);
    if (reference === 'source') database.db.prepare('DELETE FROM database_connections WHERE id=?').run(context.connectionId);
    if (reference === 'job') database.db.prepare('DELETE FROM backup_jobs WHERE id=?').run('j');
    const outcome = await adapter.executePair(context,new AbortController().signal); store.finishAttempt(context,outcome);
    expect(outcome.status).toBe('failed'); expect(outcome.error).toMatch(/not found|no longer exists/);
    const run = database.db.prepare('SELECT database_connection_id,storage_target_id,execution_id,attempt_id FROM backup_runs WHERE id=?').get(outcome.runId);
    expect(run).toEqual({database_connection_id:context.connectionId,storage_target_id:context.storageTargetId,execution_id:e.id,attempt_id:context.attemptId});
  });
});

