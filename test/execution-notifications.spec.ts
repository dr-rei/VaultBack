import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../src/database/database.service';
import { ExecutionStore } from '../src/backup/execution.store';
import { ExecutionService } from '../src/backup/execution.service';
import { SystemService } from '../src/system/system.service';
import { NotificationOutboxService } from '../src/system/notification-outbox.service';

describe('execution notification outbox', () => {
  let database: DatabaseService; let outbox: NotificationOutboxService; let system: SystemService; let send: jest.SpyInstance; let queue: ExecutionService; let directory: string; let previous: string | undefined;
  const now = new Date('2026-10-31T12:00:00Z');
  beforeEach(async () => {
    previous = process.env.DATA_DIR; directory = fs.mkdtempSync(path.join(os.tmpdir(),'vaultback-protection-')); process.env.DATA_DIR = directory;
    database = new DatabaseService(); await database.onModuleInit(); system = new SystemService(database,{} as any); outbox = new NotificationOutboxService(database,system); system.saveNotificationSettings({enabled:true,provider:"generic",webhookUrl:"https://example.invalid/notify"}); send = jest.spyOn(system,"sendNotification").mockResolvedValue(); queue = new ExecutionService(new ExecutionStore(database));
    const db = database.db;
    db.prepare('INSERT INTO users(id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)').run('admin','admin','dummy','admin',now.toISOString());
    db.prepare('INSERT INTO database_connections(id,name,engine,host,port,username,password_enc,database_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('c','source','mysql','localhost',3306,'u','encrypted','db',now.toISOString());
    for (const id of ['s1','s2']) db.prepare('INSERT INTO storage_targets(id,name,type,config_enc,created_at) VALUES (?,?,?,?,?)').run(id,id,'local','encrypted',now.toISOString());
    db.prepare('INSERT INTO backup_jobs(id,name,database_connection_id,storage_target_id,cron_expression,filename_prefix,database_scope,database_names,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('j','job','c','s1','0 0 * * *','backup','selected','["db"]','2026-10-29T00:00:00Z');
    db.prepare('INSERT INTO backup_job_connections(job_id,connection_id,database_names,position) VALUES (?,?,?,?)').run('j','c','["db"]',0);
    for (const [position,id] of ['s1','s2'].entries()) db.prepare('INSERT INTO backup_job_storages(job_id,storage_target_id,position) VALUES (?,?,?)').run('j',id,position);
  });
  afterEach(async () => { await outbox.stop(); await database.onModuleDestroy(); if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; fs.rmSync(directory,{recursive:true,force:true}); });
  function run(retries = 1) { database.db.prepare('UPDATE backup_jobs SET retry_count=?,retry_delay_seconds=0').run(retries); return queue.enqueue('j','manual',{userId:'admin'}); }
  function finish(id: string, status: 'failed' | 'success') { const store = new ExecutionStore(database); const context = store.startAttempt(id); store.finishAttempt(context,{status,runId:'run',cleanupWarnings:[]}); }
  it('groups the first failure immediately and reports automatic recovery independently of success preference', async () => {
    const execution = run();
    finish(execution.pairs[0].id,'failed'); finish(execution.pairs[1].id,'failed');
    await outbox.deliverDue(new Date(Date.now()+1000));
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0]).toBe('backup_failed');
    expect(send.mock.calls[0][1]).toContain('source'); expect(send.mock.calls[0][1]).toContain('s1'); expect(send.mock.calls[0][1]).toContain('s2');
    finish(execution.pairs[0].id,'success'); finish(execution.pairs[1].id,'success');
    await outbox.deliverDue(new Date(Date.now()+1000));
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0]).toBe('backup_recovered');
    expect(send.mock.calls[1][1]).toContain('recovered all');
  });
  it('avoids duplicate first/final messages when terminal failure is already known', async () => {
    const execution = run(0); for (const pair of execution.pairs) finish(pair.id,'failed');
    await outbox.deliverDue(new Date(Date.now()+1000));
    expect(send).toHaveBeenCalledTimes(1); expect(outbox.list()).toEqual([expect.objectContaining({kind:'final_failure',status:'delivered'})]);
  });
  it('retains a first failure and then reports exhausted retries', async () => {
    const execution = run(); finish(execution.pairs[0].id,'failed'); await outbox.deliverDue(new Date(Date.now()+1000));
    finish(execution.pairs[0].id,'failed'); finish(execution.pairs[1].id,'success'); await outbox.deliverDue(new Date(Date.now()+1000));
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][1]).toContain('unsuccessful pairs');
  });
  it('honors changed preferences before delivery and never invokes disabled providers', async () => {
    outbox.record({eventId:'disabled',kind:'first_failure',pairs:[],message:'failure'});
    system.saveNotificationSettings({enabled:false}); await outbox.deliverDue(new Date(Date.now()+1000));
    expect(send).not.toHaveBeenCalled(); expect(outbox.list()[0]).toMatchObject({status:'suppressed',attempts:0});
  });
  it('persists bounded safe errors and retries five times with durable delays', async () => {
    outbox.record({eventId:'retry',kind:'first_failure',pairs:[],message:'failure'});
    send.mockRejectedValue(new Error('secret https://credential.invalid/token'));
    let time = Date.now()+1000;
    for (const delay of [1,5,15,60,60]) { await outbox.deliverDue(new Date(time)); time += delay*60000 + 1000; }
    expect(outbox.list()[0]).toMatchObject({status:'exhausted',attempts:5,lastError:'Notification delivery failed'});
  });
  it('keeps cursor and stable IDs across service restart', async () => {
    const execution = run(0); for (const pair of execution.pairs) finish(pair.id,'failed');
    await outbox.deliverDue(new Date(Date.now()+1000));
    expect(send).toHaveBeenCalledTimes(1);
    await outbox.stop(); await database.onModuleDestroy();
    database = new DatabaseService(); await database.onModuleInit(); system = new SystemService(database,{} as any);
    send = jest.spyOn(system,'sendNotification').mockResolvedValue();
    outbox = new NotificationOutboxService(database,system); await outbox.deliverDue(new Date(Date.now()+2000));
    expect(send).not.toHaveBeenCalled(); expect(outbox.list()).toHaveLength(1);
    expect(database.db.prepare('SELECT value FROM app_settings WHERE key=?').get('notification_event_cursor')).toBeDefined();
  });
  it('scopes manual child success to selected pairs and parent', async () => {
    const execution = run(0); for (const pair of execution.pairs) finish(pair.id,'failed');
    const child = queue.retry(execution.id,[{connectionId:'c',storageTargetId:'s1'}],{userId:'admin'});
    system.saveNotificationSettings({enabled:true,provider:'generic',webhookUrl:'https://example.invalid',events:{backup_success:true}});
    finish(child.pairs[0].id,'success'); await outbox.deliverDue(new Date(Date.now()+1000));
    const message = send.mock.calls.find(call => call[0] === 'backup_recovered')?.[1];
    expect(message).toContain('Selected pairs'); expect(message).toContain(execution.id); expect(message).not.toContain('recovered all');
  });
  it('never labels cancellation or policy supersession as recovery', async () => {
    const execution = run(); finish(execution.pairs[0].id,'failed'); queue.cancel(execution.id,{userId:'admin'});
    database.db.prepare('INSERT INTO execution_events(id,kind,payload_json,created_at) VALUES (?,?,?,?)').run('closed','protection_incident_closed',JSON.stringify({incidentId:'incident',assessment:{reason:'configuration_changed'}}),database.now());
    await outbox.deliverDue(new Date(Date.now()+1000)); expect(send).not.toHaveBeenCalled();
  });
  it('persists timeout classification and advances the retry deadline', async () => {
    outbox.record({eventId:'timeout',kind:'first_failure',pairs:[],message:'failure'});
    send.mockRejectedValue(Object.assign(new Error('secret'),{name:'TimeoutError'}));
    const time = new Date(Date.now()+1000); await outbox.deliverDue(time);
    expect(outbox.list()[0]).toMatchObject({status:'pending',attempts:1,lastError:'Notification delivery timed out'});
  });
  it('uses distinct truthful protection resolution messages and category preferences', async () => {
    for (const kind of ['freshness','missed_start','long_running']) {
      database.db.prepare('INSERT INTO execution_events(id,kind,payload_json,created_at) VALUES (?,?,?,?)').run(kind,'protection_incident_resolved',JSON.stringify({incidentId:kind,assessment:{kind,jobId:'j',connectionId:'c',storageTargetId:'s1'}}),database.now());
    }
    await outbox.deliverDue(new Date(Date.now()+1000));
    expect(send.mock.calls.map(call => call[0])).toEqual(['backup_stale','backup_missed_start','backup_long_running']);
    expect(send.mock.calls[0][1]).toContain('Verified protection is fresh');
    expect(send.mock.calls[1][1]).toContain('work started'); expect(send.mock.calls[2][1]).toContain('inspect its outcome');
  });
  it('supersedes undelivered first-failure messages when execution recovers', async () => {
    const execution = run(); finish(execution.pairs[0].id,'failed');
    send.mockRejectedValueOnce(new Error('offline')); await outbox.deliverDue(new Date(Date.now()+1000));
    finish(execution.pairs[0].id,'success'); finish(execution.pairs[1].id,'success');
    await outbox.deliverDue(new Date(Date.now()+120000));
    expect(outbox.list().find((row: any) => row.kind === 'first_failure')).toMatchObject({status:'superseded',attempts:1});
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0]).toBe('backup_recovered');
  });
  it('shares one delivery promise across concurrent callers and drains before close', async () => {
    outbox.record({eventId:'concurrent',kind:'first_failure',pairs:[],message:'failure'});
    let release!: () => void; send.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const first = outbox.deliverDue(new Date(Date.now()+1000)); const second = outbox.deliverDue(new Date(Date.now()+1000));
    expect(first).toBe(second); expect(send).toHaveBeenCalledTimes(1);
    const stop = outbox.stop(); release(); await stop; await first;
    expect(outbox.list()[0]).toMatchObject({status:'delivered'});
  });
  it('advances past malformed events with visible safe evidence', async () => {
    database.db.prepare('INSERT INTO execution_events(id,kind,payload_json,created_at) VALUES (?,?,?,?)').run('bad','protection_incident_opened','{broken',database.now());
    const execution = run(0); for (const pair of execution.pairs) finish(pair.id,'failed');
    await outbox.deliverDue(new Date(Date.now()+1000));
    expect(outbox.list().find((row: any) => row.kind === 'invalid_event')).toMatchObject({status:'exhausted',lastError:'Invalid persisted notification event'});
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('materializes new failure intent every second while a provider is blocked', async () => {
    jest.useFakeTimers();
    try {
      outbox.record({eventId:'blocked',kind:'first_failure',pairs:[],message:'failure'});
      let release!: () => void; send.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
      outbox.onApplicationBootstrap();
      const execution = run(); finish(execution.pairs[0].id,'failed');
      jest.advanceTimersByTime(1000);
      expect(outbox.list().find((row: any) => row.executionId === execution.id)).toMatchObject({kind:'first_failure',status:'pending'});
      expect(send).toHaveBeenCalledTimes(1); release(); await outbox.stop();
    } finally { jest.useRealTimers(); }
  });
  it.each(['protection_incident_resolved','protection_incident_closed'])('supersedes obsolete pending incident alerts on %s', async kind => {
    const payload = JSON.stringify({incidentId:'obsolete',assessment:{kind:'freshness',jobId:'j',connectionId:'c',storageTargetId:'s1'}});
    database.db.prepare('INSERT INTO execution_events(id,kind,payload_json,created_at) VALUES (?,?,?,?)').run('opened','protection_incident_opened',payload,database.now());
    send.mockRejectedValueOnce(new Error('offline')); await outbox.deliverDue(new Date(Date.now()+1000));
    database.db.prepare('INSERT INTO execution_events(id,kind,payload_json,created_at) VALUES (?,?,?,?)').run('ended',kind,payload,database.now());
    await outbox.deliverDue(new Date(Date.now()+120000));
    expect(outbox.list().find((row: any) => row.id === 'opened')).toMatchObject({status:'superseded'});
    expect(send).toHaveBeenCalledTimes(kind.endsWith('_resolved') ? 2 : 1);
    if (kind.endsWith('_resolved')) expect(send.mock.calls[1][1]).toContain('Verified protection is fresh');
  });
  it('starts retry backoff after each actual provider completion', async () => {
    jest.useFakeTimers();
    try {
      const time = new Date();
      outbox.record({eventId:'slow-first',kind:'first_failure',pairs:[],message:'first'});
      outbox.record({eventId:'slow-second',kind:'first_failure',pairs:[],message:'second'});
      let reject!: (error: Error) => void;
      send.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; })).mockRejectedValueOnce(new Error('offline'));
      const delivery = outbox.deliverDue(time); jest.setSystemTime(time.getTime()+250000); reject(new Error('offline')); await delivery;
      for (const row of outbox.list() as any[]) expect(row.nextAttemptAt).toBe(new Date(time.getTime()+310000).toISOString());
      await outbox.deliverDue(new Date(time.getTime()+300000)); expect(send).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });
  it('preserves omitted legacy and new preferences when saving another switch', () => {
    system.saveNotificationSettings({enabled:true,provider:'generic',webhookUrl:'https://example.invalid',events:{backup_retry:false,backup_recovered:false}});
    system.saveNotificationSettings({enabled:true,provider:'generic',webhookUrl:'https://example.invalid',events:{backup_stale:false}});
    expect(system.getNotificationSettings().events).toMatchObject({backup_retry:false,backup_recovered:false,backup_stale:false,backup_success:false,backup_missed_start:true,backup_long_running:true});
  });
  it('rejects non-2xx and supplies a ten-second abort signal without real calls', async () => {
    send.mockRestore(); const fetchMock = jest.spyOn(globalThis,'fetch').mockResolvedValue({ok:false,status:503} as Response);
    try { await expect(system.sendNotification('backup_failed','test')).rejects.toThrow('HTTP 503'); expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal); }
    finally { fetchMock.mockRestore(); }
  });
});

