import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../src/database/database.service';
import { BackupService } from '../src/backup/backup.service';
import { ProtectionService } from '../src/backup/protection.service';
import { ExecutionStore } from '../src/backup/execution.store';
import { ExecutionService } from '../src/backup/execution.service';

describe('pair protection policy', () => {
  let database: DatabaseService; let policy: ProtectionService; let queue: ExecutionService; let directory: string; let previous: string | undefined;
  const now = new Date('2026-10-31T12:00:00Z');
  beforeEach(async () => {
    previous = process.env.DATA_DIR; directory = fs.mkdtempSync(path.join(os.tmpdir(),'vaultback-protection-')); process.env.DATA_DIR = directory;
    database = new DatabaseService(); await database.onModuleInit(); policy = new ProtectionService(database); queue = new ExecutionService(new ExecutionStore(database));
    const db = database.db;
    db.prepare('INSERT INTO users(id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)').run('admin','admin','dummy','admin',now.toISOString());
    db.prepare('INSERT INTO database_connections(id,name,engine,host,port,username,password_enc,database_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('c','source','mysql','localhost',3306,'u','encrypted','db',now.toISOString());
    for (const id of ['s1','s2']) db.prepare('INSERT INTO storage_targets(id,name,type,config_enc,created_at) VALUES (?,?,?,?,?)').run(id,id,'local','encrypted',now.toISOString());
    db.prepare('INSERT INTO backup_jobs(id,name,database_connection_id,storage_target_id,cron_expression,filename_prefix,database_scope,database_names,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('j','job','c','s1','0 0 * * *','backup','selected','["db"]','2026-10-29T00:00:00Z');
    db.prepare('INSERT INTO backup_job_connections(job_id,connection_id,database_names,position) VALUES (?,?,?,?)').run('j','c','["db"]',0);
    for (const [position,id] of ['s1','s2'].entries()) db.prepare('INSERT INTO backup_job_storages(job_id,storage_target_id,position) VALUES (?,?,?)').run('j',id,position);
  });
  afterEach(() => { database.onModuleDestroy(); if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; fs.rmSync(directory,{recursive:true,force:true}); });
  function artifact(id: string, target: string, stamp: string, verified = 'passed') {
    database.db.prepare('INSERT INTO backup_runs(id,job_id,status,started_at,finished_at,database_connection_id,storage_target_id,database_scope,database_names,backup_layout,backup_objects,insert_mode,compression,backup_encryption,verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'j','success',stamp,stamp,'c',target,'selected','["db"]','single','{"views":true,"routines":true,"triggers":true,"events":true}','extended','gzip','none',verified);
  }
  it('keeps separate required clocks and does not reset on unverified upload', () => {
    artifact('old','s1','2026-10-29T00:00:00Z'); artifact('unverified','s1','2026-10-31T11:00:00Z','failed'); artifact('fresh','s2','2026-10-31T11:00:00Z');
    expect(policy.assess(now).map(item => item.freshnessStatus)).toEqual(['stale','fresh']);
    policy.evaluateIncidents(now); policy.evaluateIncidents(now);
    expect(database.db.prepare('SELECT * FROM protection_incidents').all()).toHaveLength(1);
    expect(database.db.prepare('SELECT * FROM execution_events').all()).toHaveLength(1);
    artifact('recovered','s1','2026-10-31T11:30:00Z'); policy.evaluateIncidents(now);
    expect(database.db.prepare('SELECT status FROM protection_incidents').get()).toEqual({status:'resolved'});
    expect(database.db.prepare('SELECT * FROM execution_events').all()).toHaveLength(2);
  });
  it('shows optional failures without required protection incidents', () => {
    database.db.prepare('UPDATE backup_job_storages SET required=0 WHERE storage_target_id=?').run('s2');
    artifact('fresh','s1','2026-10-31T11:00:00Z'); artifact('bad','s2','2026-10-29T00:00:00Z','failed');
    expect(policy.assess(now)[1]).toMatchObject({required:false,freshnessStatus:'stale',evidence:{latestOutcome:'success'}});
    policy.evaluateIncidents(now); expect(database.db.prepare('SELECT * FROM protection_incidents').all()).toHaveLength(0);
  });
  it('requires complete matching configuration and rejects inherited selection freshness', () => {
    artifact('fresh','s1','2026-10-31T11:00:00Z');
    database.db.prepare('UPDATE backup_job_connections SET database_names=?').run('["changed"]');
    expect(policy.assess(now)[0]).toMatchObject({freshnessStatus:'unknown',latestVerifiedRunId:null});
    database.db.prepare('UPDATE backup_job_connections SET database_names=?').run('["db"]');
    database.db.prepare('UPDATE backup_runs SET insert_mode=NULL').run();
    expect(policy.assess(now)[0].freshnessStatus).toBe('unknown');
  });
  it('gives a new schedule explicit grace and suppresses paused incidents', () => {
    database.db.prepare('UPDATE backup_jobs SET created_at=?').run('2026-10-31T11:00:00Z');
    expect(policy.assess(now)[0].freshnessStatus).toBe('grace');
    database.db.prepare('UPDATE backup_jobs SET created_at=?,enabled=0,next_run_at=?').run('2026-10-29T00:00:00Z','2026-10-30T00:00:00Z');
    expect(policy.assess(now)[0]).toMatchObject({freshnessStatus:'paused',missedStartStatus:'paused'});
    policy.evaluateIncidents(now); expect(database.db.prepare('SELECT * FROM protection_incidents').all()).toHaveLength(0);
    database.db.prepare('UPDATE backup_jobs SET enabled=1').run(); expect(policy.assess(now)[0].freshnessStatus).toBe('stale');
  });
  it('separates queued missed starts from running and retrying duration', () => {
    const execution = queue.enqueue('j','scheduled',null,'2026-10-31T10:00:00Z');
    database.db.prepare('UPDATE backup_executions SET queued_at=?').run('2026-10-31T10:00:00Z');
    expect(policy.assess(now)[0]).toMatchObject({missedStartStatus:'missed',longRunningStatus:'normal'});
    database.db.prepare('UPDATE backup_execution_pairs SET status=?,started_at=? WHERE id=?').run('running','2026-10-31T09:00:00Z',execution.pairs[0].id);
    database.db.prepare('INSERT INTO backup_execution_attempts(id,pair_id,attempt_number,status,started_at) VALUES (?,?,?,?,?)').run('attempt',execution.pairs[0].id,1,'running','2026-10-31T09:00:00Z');
    expect(policy.assess(now)[0]).toMatchObject({missedStartStatus:'on_time',longRunningStatus:'long_running'});
  });
  it('reports clock rollback as unknown without new incidents', () => {
    artifact('future','s1','2026-11-01T11:00:00Z');
    expect(policy.assess(now)[0]).toMatchObject({freshnessStatus:'unknown',evidence:{clockRollback:true}});
    database.db.prepare('UPDATE backup_jobs SET enabled=0').run(); policy.evaluateIncidents(now);
    expect(database.db.prepare('SELECT * FROM protection_incidents').all()).toHaveLength(0);
  });
  it('treats future current attempt timestamps as unknown evidence', () => {
    const execution = queue.enqueue('j','scheduled',null,'2026-10-31T10:00:00Z');
    database.db.prepare('UPDATE backup_executions SET queued_at=?').run('2026-10-31T10:00:00Z');
    database.db.prepare("UPDATE backup_execution_pairs SET status='running',started_at=? WHERE id=?").run('2026-10-31T10:00:00Z',execution.pairs[0].id);
    database.db.prepare('INSERT INTO backup_execution_attempts(id,pair_id,attempt_number,status,started_at) VALUES (?,?,?,?,?)').run('future-attempt',execution.pairs[0].id,1,'running','2026-11-01T09:00:00Z');
    expect(policy.assess(now)[0].longRunningStatus).toBe('unknown');
  });

  it('never labels changed policy as recovered protection', () => {
    policy.evaluateIncidents(now);
    database.db.prepare('UPDATE backup_job_storages SET required=0').run();
    policy.evaluateIncidents(now);
    const events = database.db.prepare('SELECT kind,payload_json FROM execution_events').all() as any[];
    expect(events.filter(event => event.kind === 'protection_incident_resolved')).toHaveLength(0);
    expect(events.filter(event => event.kind === 'protection_incident_closed')).toHaveLength(2);
    expect(JSON.parse(events[2].payload_json).assessment.reason).toBe('destination_optional');
  });
  it('uses only current attempt runtime and excludes retry delay', () => {
    const execution = queue.enqueue('j','manual',{userId:'admin'});
    database.db.prepare('UPDATE backup_executions SET queued_at=?').run('2026-10-31T08:00:00Z');
    database.db.prepare("UPDATE backup_execution_pairs SET status='running',started_at=? WHERE id=?").run('2026-10-31T08:00:00Z',execution.pairs[0].id);
    database.db.prepare('INSERT INTO backup_execution_attempts(id,pair_id,attempt_number,status,started_at) VALUES (?,?,?,?,?)').run('new-attempt',execution.pairs[0].id,2,'running','2026-10-31T11:45:00Z');
    expect(policy.assess(now)[0].longRunningStatus).toBe('normal');
    database.db.prepare("UPDATE backup_execution_pairs SET status='retry_wait' WHERE id=?").run(execution.pairs[0].id);
    database.db.prepare("UPDATE backup_execution_attempts SET status='failed',started_at=?").run('2026-10-31T08:00:00Z');
    expect(policy.assess(now)[0].longRunningStatus).toBe('normal');
  });
  it('clears missed-start condition after the next scheduled occurrence starts', () => {
    queue.enqueue('j','scheduled',null,'2026-10-31T08:00:00Z');
    const later = queue.enqueue('j','scheduled',null,'2026-10-31T10:00:00Z');
    database.db.prepare('UPDATE backup_executions SET queued_at=?').run('2026-10-31T10:00:00Z');
    expect(policy.assess(now)[0].missedStartStatus).toBe('missed');
    database.db.prepare("UPDATE backup_execution_pairs SET status='success',started_at=? WHERE execution_id=?").run('2026-10-31T10:01:00Z',later.id);
    expect(policy.assess(now)[0].missedStartStatus).toBe('on_time');
  });

  it('preserves optional flags on legacy edits and validates separate schedule thresholds', () => {
    const backups = new BackupService(database,{} as any,{} as any,{} as any);
    const body = {id:'j',name:'job',connectionIds:['c'],storageTargetIds:['s1','s2'],databaseScope:'selected',databaseSelections:[{connectionId:'c',databases:['db']}],cronExpression:'0 0 * * *'};
    backups.saveJobV2({...body,storageRequirements:[{storageTargetId:'s2',required:false}],missedStartGraceMinutes:20,maxVerifiedAgeHours:30,longRunningWarningMinutes:140});
    const saved = backups.saveJobV2(body);
    expect(saved).toMatchObject({missedStartGraceMinutes:20,maxVerifiedAgeHours:30,longRunningWarningMinutes:140,storageRequirements:[{storageTargetId:'s1',required:true},{storageTargetId:'s2',required:false}]});
    expect(backups.listJobs()[0].storageRequirements[1].required).toBe(false);
    for (const key of ['missedStartGraceMinutes','maxVerifiedAgeHours','longRunningWarningMinutes']) expect(() => backups.saveJobV2({...body,[key]:0})).toThrow('integer between');
    expect(() => backups.saveJobV2({...body,storageRequirements:[{storageTargetId:'other',required:false}]})).toThrow('selected targets');
  });

  it.each(['{broken','{"db":"wrong shape"}'])('isolates malformed selection %s from valid pairs', malformed => {
    artifact('valid','s1','2026-10-31T11:00:00Z');
    database.db.prepare('INSERT INTO backup_jobs(id,name,database_connection_id,storage_target_id,cron_expression,filename_prefix,database_scope,database_names,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('bad','bad','c','s1','0 0 * * *','bad','selected',malformed,'2026-10-29T00:00:00Z');
    const assessments = policy.assess(now);
    expect(assessments.find(item => item.jobId === 'j' && item.storageTargetId === 's1')?.freshnessStatus).toBe('fresh');
    expect(assessments.find(item => item.jobId === 'bad')).toMatchObject({freshnessStatus:'unknown',evidence:{reason:'Invalid persisted backup selection configuration'}});
    expect(() => policy.evaluateIncidents(now)).not.toThrow();
  });
  it('rejects future unverified artifact timestamps without resolving existing incidents', () => {
    artifact('old','s1','2026-10-29T00:00:00Z'); policy.evaluateIncidents(now);
    artifact('future-unverified','s1','2026-11-01T11:00:00Z','failed');
    expect(policy.assess(now)[0]).toMatchObject({freshnessStatus:'unknown',evidence:{clockRollback:true}});
    policy.evaluateIncidents(now);
    expect(database.db.prepare("SELECT * FROM execution_events WHERE kind='protection_incident_resolved'").all()).toHaveLength(0);
  });

});
