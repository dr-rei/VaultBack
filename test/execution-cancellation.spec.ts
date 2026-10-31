import childProcess from 'node:child_process';
import mysql from 'mysql2/promise';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DataOwner } from '../src/database/data-owner';
import fs from 'node:fs';
import { Client } from 'basic-ftp';
import { S3Client } from '@aws-sdk/client-s3';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../src/database/database.service';
import { ExecutionService } from '../src/backup/execution.service';
import { ExecutionStore } from '../src/backup/execution.store';
import { StorageService } from '../src/storage/storage.service';
import { BackupService } from '../src/backup/backup.service';

describe('execution cancellation', () => {
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
  afterEach(async () => { await database.onModuleDestroy(); if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; fs.rmSync(directory,{recursive:true,force:true}); });
  it('cancels queued pairs without launching attempts and enforces administrator role', () => {
    const e = service.enqueue('j','manual',actor);
    expect(() => service.cancel(e.id,{userId:'missing'})).toThrow('Administrator');
    const result = service.cancel(e.id,actor);
    expect(result.status).toBe('cancelled');
    expect(result.pairs.every(pair => pair.status === 'not_started' && pair.attempts.length === 0)).toBe(true);
    expect(store.readyPairs()).toHaveLength(0);
    expect(service.cancel(e.id,actor)).toEqual(result);
  });
  it('requires confirmation, prevents retries, preserves success and ignores late callbacks', () => {
    database.db.prepare('UPDATE backup_jobs SET retry_count=3 WHERE id=?').run('j');
    const e = service.enqueue('j','manual',actor);
    const first = store.startAttempt(e.pairs[0].id);
    const second = store.startAttempt(e.pairs[1].id);
    expect(() => service.cancel(e.id,actor)).toThrow('Confirm');
    expect(service.cancel(e.id,actor,true).status).toBe('cancel_requested');
    expect(() => service.assignGroup(['c1'],'custom','Custom',1,actor)).toThrow('queued or running');
    store.finishAttempt(first,{runId:'confirmed',status:'success',cleanupWarnings:['Retention cancelled']});
    store.finishAttempt(second,{runId:'stopped',status:'failed',cleanupWarnings:[]});
    const result = service.get(e.id);
    expect(result.status).toBe('cancelled');
    expect(result.pairs.map(pair => pair.status)).toEqual(['success','cancelled','not_started','not_started','not_started','not_started']);
    expect(result.pairs[1].attempts[0].status).toBe('cancelled');
    store.finishAttempt(first,{runId:'late',status:'failed',cleanupWarnings:[]});
    expect(service.get(e.id)).toEqual(result);
    expect(store.readyPairs()).toHaveLength(0);
  });
  it('cancels retry waits without rewriting the failed attempt', () => {
    database.db.prepare('UPDATE backup_jobs SET retry_count=3 WHERE id=?').run('j');
    const e = service.enqueue('j','manual',actor); const context = store.startAttempt(e.pairs[0].id);
    store.finishAttempt(context,{runId:'failed',status:'failed',cleanupWarnings:[]});
    expect(service.get(e.id).pairs[0].status).toBe('retry_wait');
    const prior = service.get(e.id).pairs[0].attempts;
    expect(service.cancel(e.id,actor).status).toBe('cancelled');
    expect(service.get(e.id).pairs[0].attempts).toEqual(prior);
  });
  it('stops running adapters, never launches queued pairs and releases capacity only after settlement', async () => {
    let release!: () => void;
    const settled = new Promise<void>(resolve => { release = resolve; });
    const executePair = jest.fn(async (_context, signal: AbortSignal) => {
      await settled;
      return {runId:'cancelled-run',status:signal.aborted ? 'cancelled' as const : 'success' as const,cleanupWarnings:[]};
    });
    service = new ExecutionService(store,{registerCoordinator:jest.fn(),executePair} as any);
    const e = service.enqueue('j','manual',actor);
    await Promise.resolve(); await Promise.resolve();
    expect(executePair).toHaveBeenCalledTimes(1);
    const cancellation = service.cancel(e.id,actor,true);
    expect(cancellation.status).toBe('cancel_requested');
    expect(executePair.mock.calls[0][1].aborted).toBe(true);
    service.pump(); expect(executePair).toHaveBeenCalledTimes(1);
    release(); await service.drain();
    expect(service.get(e.id).status).toBe('cancelled');
    expect((service as any).workers.size).toBe(0);
    expect(executePair).toHaveBeenCalledTimes(1);
  });

  it.each([false,true])('derives interrupted aggregate while preserving successes (%s)', succeeded => {
    const execution = service.enqueue('j','manual',actor);
    execution.pairs.forEach((pair,index) => {
      const context = store.startAttempt(pair.id);
      store.finishAttempt(context,{runId:String(index),status:succeeded && index === 0 ? 'success' : 'interrupted',cleanupWarnings:[]});
    });
    expect(service.get(execution.id).status).toBe(succeeded ? 'partial_failure' : 'interrupted');
  });
  it('expires acknowledged retention deletions even when the following deletion is cancelled', async () => {
    const execution = service.enqueue('j','manual',actor); const context = store.startAttempt(execution.pairs[0].id);
    const controller = new AbortController(); const folder = 'schedule-j-c1';
    const storageRoot = path.join(directory,'backups'); const destination = path.join(storageRoot,folder); fs.mkdirSync(destination,{recursive:true});
    for (const name of ['backup-z.sql','backup-b.sql','backup-a.sql']) fs.writeFileSync(path.join(destination,name),'old');
    for (const [id,filename] of [['old-confirmed','backup-b.sql'],['old-uncertain','backup-a.sql']]) {
      database.db.prepare('INSERT INTO backup_runs(id,job_id,status,started_at,filename,storage_target_id,storage_folder,verification_status) VALUES (?,?,?,?,?,?,?,?)').run(id,'j','success',database.now(),filename,'s1',folder,'verified');
    }
    const target: any = {id:'s1',type:'local',config:{path:storageRoot}};
    const storageService = new StorageService(database,{} as any);
    const storage = {get:() => target, upload:async () => ({location:'confirmed'}), rotate:async (_target: any,prefix: string,_count: number,storageFolder: string,signal: AbortSignal,onRemoved: (filename:string) => void) => storageService.rotate(target,prefix,1,storageFolder,signal,filename => { onRemoved(filename); controller.abort(new Error('Stop retention')); })};
    const adapter = new BackupService(database,storage as any,{} as any,{publish:jest.fn(),publishThrottled:jest.fn()} as any);
    jest.spyOn(adapter as any,'listAvailableTables').mockResolvedValue({tables:['table'],views:[]});
    jest.spyOn(adapter as any,'dump').mockImplementation(async (...args: any[]) => { fs.writeFileSync(args[1],'-- MySQL dump\nCREATE TABLE table (id INT);'); });
    const outcome = await adapter.executePair(context,controller.signal);
    expect(outcome.status).toBe('success'); expect(outcome.cleanupWarnings.join(' ')).toContain('unacknowledged deletion');
    expect(database.db.prepare('SELECT status FROM backup_runs WHERE id=?').get('old-confirmed')).toEqual({status:'expired'});
    expect(database.db.prepare('SELECT status FROM backup_runs WHERE id=?').get('old-uncertain')).toEqual({status:'success'});
    expect(fs.existsSync(path.join(destination,'backup-b.sql'))).toBe(false);
    expect(fs.existsSync(path.join(destination,'backup-a.sql'))).toBe(true);
  });

  it('closes an in-flight FTP retention operation on abort and reports only acknowledged deletions', async () => {
    const controller = new AbortController(); let rejectRemove!: (error: Error) => void;
    const access = jest.spyOn(Client.prototype,'access').mockResolvedValue({} as any);
    const list = jest.spyOn(Client.prototype,'list').mockResolvedValue(['backup-z','backup-b','backup-a'].map(name => ({name,type:1})) as any);
    const remove = jest.spyOn(Client.prototype,'remove').mockImplementationOnce(async () => ({} as any)).mockImplementationOnce(() => new Promise((_resolve,reject) => { rejectRemove = reject; }));
    const close = jest.spyOn(Client.prototype,'close').mockImplementation(() => rejectRemove?.(new Error('FTP operation aborted')));
    try {
      const acknowledged: string[] = []; const storage = new StorageService(database,{} as any);
      const work = storage.rotate({id:'ftp',type:'ftp',config:{host:'example.invalid',port:21,username:'u',password:'p'}} as any,'backup',1,'',controller.signal,name => acknowledged.push(name));
      for (let i=0;i<8 && !rejectRemove;i++) await Promise.resolve();
      expect(remove).toHaveBeenCalledTimes(2); controller.abort();
      await expect(work).rejects.toThrow('aborted');
      expect(acknowledged).toEqual(['backup-b']); expect(close).toHaveBeenCalled();
    } finally { access.mockRestore(); list.mockRestore(); remove.mockRestore(); close.mockRestore(); }
  });
  it('passes cancellation into S3 retention listing and deletion and does not acknowledge an uncertain delete', async () => {
    const controller = new AbortController(); const acknowledged: string[] = [];
    const send = jest.spyOn(S3Client.prototype,'send').mockImplementation((async (command: any,options: any) => {
      expect(options.abortSignal).toBe(controller.signal);
      if (command.constructor.name === 'ListObjectsV2Command') return {Contents:[{Key:'backup-z'},{Key:'backup-b'},{Key:'backup-a'}]};
      if (command.input.Delete.Objects[0].Key === 'backup-b') return {};
      controller.abort(); throw new Error('S3 deletion aborted before acknowledgement');
    }) as any);
    try {
      const storage = new StorageService(database,{} as any);
      await expect(storage.rotate({id:'s3',type:'s3',config:{bucket:'test-bucket',accessKeyId:'fake',secretAccessKey:'fake'}} as any,'backup',1,'',controller.signal,name => acknowledged.push(name))).rejects.toThrow('before acknowledgement');
      expect(acknowledged).toEqual(['backup-b']); expect(send).toHaveBeenCalledTimes(3);
    } finally { send.mockRestore(); }
  });

  it.each([0,null])('waits for the dump child exit and output closure after cancellation (exit %s)', async exitCode => {
    const child = Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:jest.fn(() => true)});
    const spawned = jest.spyOn(childProcess,'spawn').mockReturnValue(child as any);
    try {
      const adapter: any = new BackupService(database,{} as any,{} as any,{} as any);
      jest.spyOn(adapter,'resolveClientBinary').mockReturnValue(process.execPath);
      jest.spyOn(adapter,'clientToolArgs').mockReturnValue([]);
      const controller = new AbortController(); const output = path.join(directory,'dummy.sql');
      let finished = false;
      const work = adapter.executionSignal.run(controller.signal,() => adapter.dumpWithArgs({engine:'mysql',host:'unused',port:3306,username:'u',password:'fake'},output,[]));
      const observed = work.catch((error: Error) => { expect(error.message).toBe('Stop dummy dump'); }).finally(() => { finished = true; });
      child.stdout.write('-- dummy output'); controller.abort(new Error('Stop dummy dump'));
      await new Promise(resolve => setImmediate(resolve));
      expect(child.kill).toHaveBeenCalledWith('SIGTERM'); expect(finished).toBe(false);
      if (exitCode === null) { await new Promise(resolve => setTimeout(resolve,2100)); expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(finished).toBe(false); }
      child.emit('close',exitCode); await observed;
      expect(child.stdout.closed).toBe(true);
    } finally { spawned.mockRestore(); }
  },10000);
  it('closes the S3 upload input before returning a cancellation failure', async () => {
    const controller = new AbortController(); const file = path.join(directory,'upload.sql'); fs.writeFileSync(file,'dummy');
    let body: fs.ReadStream | undefined;
    const send = jest.spyOn(S3Client.prototype,'send').mockImplementation((async (command: any) => {
      body = command.input.Body; controller.abort(new Error('Stop upload')); throw controller.signal.reason;
    }) as any);
    try {
      const storage = new StorageService(database,{} as any);
      await expect(storage.upload({id:'s3',type:'s3',config:{bucket:'test-bucket',accessKeyId:'fake',secretAccessKey:'fake'}} as any,file,'backup.sql','',controller.signal)).rejects.toThrow('Stop upload');
      expect(body?.closed).toBe(true);
    } finally { send.mockRestore(); }
  });
  it('destroys a native query on cancellation and awaits its rejection', async () => {
    let rejectQuery!: (error: Error) => void;
    const client = {query:jest.fn(() => new Promise((_resolve,reject) => {rejectQuery = reject;})),destroy:jest.fn(() => rejectQuery(new Error('Native query cancelled'))),end:jest.fn(async () => undefined)};
    const connect = jest.spyOn(mysql,'createConnection').mockResolvedValue(client as any);
    try {
      const adapter: any = new BackupService(database,{} as any,{} as any,{} as any); const controller = new AbortController();
      const work = adapter.executionSignal.run(controller.signal,() => adapter.withNativeDatabaseConnection({host:'unused'},(connection: any) => connection.query('SELECT 1')));
      const observed = expect(work).rejects.toThrow('Native query cancelled');
      await Promise.resolve(); controller.abort(); await observed;
      expect(client.destroy).toHaveBeenCalledTimes(1); expect(client.end).toHaveBeenCalledTimes(1);
    } finally { connect.mockRestore(); }
  });
  it('recovers pending cancellation without launching or automatically retrying work', () => {
    database.db.prepare('UPDATE backup_jobs SET retry_count=3 WHERE id=?').run('j');
    const execution = service.enqueue('j','manual',actor); const context = store.startAttempt(execution.pairs[0].id);
    service.cancel(execution.id,actor,true);
    const restarted = new ExecutionService(new ExecutionStore(database)); restarted.recover();
    const recovered = restarted.get(execution.id);
    expect(recovered.status).toBe('cancelled'); expect(recovered.pairs[0].attempts[0].id).toBe(context.attemptId);
    expect(recovered.pairs[0].attempts[0].status).toBe('cancelled'); expect(recovered.pairs[0].cleanupWarnings.join(' ')).toContain('unknown');
    expect(store.readyPairs()).toHaveLength(0);
  });
  it('retains DATA_DIR writer ownership until draining workers settle', async () => {
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    service = new ExecutionService(store,{registerCoordinator:jest.fn(),executePair:async () => { await waiting; return {runId:'shutdown',status:'interrupted',cleanupWarnings:[]}; }} as any);
    service.enqueue('j','manual',actor); await Promise.resolve(); await Promise.resolve();
    let closed = false; const closing = Promise.resolve(database.onModuleDestroy()).then(() => {closed = true;});
    await Promise.resolve(); expect(closed).toBe(false);
    expect(() => DataOwner.acquire(directory)).toThrow('live writer');
    release(); await closing;
    const releaseOwner = DataOwner.acquire(directory); releaseOwner();
  });

});

