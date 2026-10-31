import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../src/database/database.service';
import { RecoveryService } from '../src/recovery/recovery.service';
import { RecoveryController } from '../src/recovery/recovery.controller';
import { BackupService } from '../src/backup/backup.service';

describe('guided artifact rehearsals', () => {
  let store: DatabaseService; let directory: string; let previous: string | undefined; let service: RecoveryService; let backups: any;
  beforeEach(async () => {
    previous = process.env.DATA_DIR; directory = fs.mkdtempSync(path.join(os.tmpdir(),'vb-guided-')); process.env.DATA_DIR = directory;
    store = new DatabaseService(); await store.onModuleInit();
    for (const [id,host,purpose] of [['source','source.test','backup'],['recovery','recovery.test','recovery']]) store.db.prepare('INSERT INTO database_connections(id,name,engine,host,port,username,password_enc,database_name,connection_purpose,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,id,'mysql',host,3306,'fixture','encrypted','db',purpose,store.now());
    store.db.prepare('INSERT INTO storage_targets(id,name,type,config_enc,created_at) VALUES (?,?,?,?,?)').run('storage','storage','local','encrypted',store.now());
    store.db.prepare('INSERT INTO backup_jobs(id,name,database_connection_id,storage_target_id,cron_expression,filename_prefix,created_at) VALUES (?,?,?,?,?,?,?)').run('job','job','source','storage','0 0 * * *','backup',store.now());
    store.db.prepare('INSERT INTO backup_runs(id,job_id,status,started_at,database_connection_id,storage_target_id,filename,sha256,database_names,expected_objects) VALUES (?,?,?,?,?,?,?,?,?,?)').run('run','job','success',store.now(),'source','storage','backup.sql','a'.repeat(64),'["db"]','{"db":{"tables":["items"],"views":[]}}');
    backups = {restoreArtifactForRehearsal:jest.fn().mockResolvedValue({verification:{status:'passed',details:[{}]},cleanupWarnings:[]})};
    service = new RecoveryService(store,backups,{} as any,{} as any);
  });
  afterEach(async () => { await store.onModuleDestroy(); if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; fs.rmSync(directory,{recursive:true,force:true}); });
  async function settle() { await new Promise(resolve => setImmediate(resolve)); }
  it('records asynchronous evidence without a recurring plan and preserves cleanup warnings', async () => {
    backups.restoreArtifactForRehearsal.mockResolvedValue({verification:{status:'passed',details:[{}]},cleanupWarnings:['DROP failed']});
    const {runId} = service.rehearseArtifact({backupRunId:'run',recoveryConnectionId:'recovery'},{userId:'operator'});
    expect(service.getArtifactRehearsal(runId).status).toBe('running'); await settle();
    expect(service.getArtifactRehearsal(runId)).toMatchObject({status:'warning',evidence:{sha256:'a'.repeat(64),cleanupWarnings:['DROP failed'],stage:'completed'}});
    expect(store.db.prepare('SELECT * FROM recovery_plans').all()).toHaveLength(0);
  });
  it('rejects normal destination and physical host/group aliases before importing', () => {
    expect(() => service.rehearseArtifact({backupRunId:'run',recoveryConnectionId:'source'},{userId:'operator'})).toThrow('recovery-only');
    store.db.prepare("UPDATE database_connections SET host='SOURCE.TEST.' WHERE id='recovery'").run();
    expect(() => service.rehearseArtifact({backupRunId:'run',recoveryConnectionId:'recovery'},{userId:'operator'})).toThrow('different source');
    store.db.prepare("UPDATE database_connections SET host='other.test',source_group_id='alias' WHERE id='recovery'").run(); store.db.prepare("UPDATE database_connections SET source_group_id='alias' WHERE id='source'").run();
    expect(() => service.rehearseArtifact({backupRunId:'run',recoveryConnectionId:'recovery'},{userId:'operator'})).toThrow('different source');
    expect(backups.restoreArtifactForRehearsal).not.toHaveBeenCalled();
  });
  it('requires hash, preserves failures and marks abandoned work interrupted', async () => {
    store.db.prepare("UPDATE backup_runs SET sha256=NULL WHERE id='run'").run();
    expect(() => service.rehearseArtifact({backupRunId:'run',recoveryConnectionId:'recovery'},{userId:'operator'})).toThrow('SHA-256');
    store.db.prepare("UPDATE backup_runs SET sha256=? WHERE id='run'").run('a'.repeat(64));
    backups.restoreArtifactForRehearsal.mockRejectedValue(new Error('Hash mismatch; cleanup warnings: scratch drop failed'));
    const {runId} = service.rehearseArtifact({backupRunId:'run',recoveryConnectionId:'recovery'},{userId:'operator'}); await settle();
    expect(service.getArtifactRehearsal(runId)).toMatchObject({status:'failed',errorMessage:expect.stringContaining('cleanup warnings')});
    store.db.prepare("UPDATE artifact_rehearsals SET status='running' WHERE id=?").run(runId); service.onApplicationBootstrap();
    expect(service.getArtifactRehearsal(runId).status).toBe('interrupted');
  });
  it('binds actor to admin session and denies unauthenticated reads', () => {
    const auth = {requireAdmin:jest.fn().mockReturnValue({user_id:'session-actor'})}; const target = {rehearseArtifact:jest.fn(),getArtifactRehearsal:jest.fn()};
    const controller = new RecoveryController(auth as any,target as any); const request = {} as any;
    controller.rehearseArtifact(request,{backupRunId:'run',recoveryConnectionId:'recovery'});
    expect(target.rehearseArtifact).toHaveBeenCalledWith({backupRunId:'run',recoveryConnectionId:'recovery'},{userId:'session-actor'});
    auth.requireAdmin.mockImplementation(() => { throw new Error('Denied'); });
    expect(() => controller.artifactRehearsal(request,'id')).toThrow('Denied'); expect(target.getArtifactRehearsal).not.toHaveBeenCalled();
  });
  it('legacy destination alias cannot bypass recovery purpose', () => {
    expect(() => service.savePlan({name:'plan',jobId:'job',destinationConnectionId:'source'})).toThrow('dedicated recovery');
  });
  function adapter() {
    store.db.prepare("UPDATE backup_runs SET database_scope='selected',backup_layout='single',compression='none',backup_encryption='none' WHERE id='run'").run();
    const file = path.join(directory,'fixture.sql'); fs.writeFileSync(file,'USE `db`; CREATE TABLE `items` (`id` int);');
    const instance: any = Object.create(BackupService.prototype);
    Object.assign(instance,{store,storage:{get:jest.fn().mockReturnValue({}),download:jest.fn().mockResolvedValue({path:file,cleanup:false})},getConnection:jest.fn().mockReturnValue({engine:'mysql'}),stageAndVerifyDownload:jest.fn().mockResolvedValue({path:file,cleanup:false}),parseExpectedObjects:jest.fn().mockReturnValue({db:['items']}),validatePitrSqlFile:jest.fn().mockResolvedValue(undefined),rewritePitrSqlFile:jest.fn().mockResolvedValue(undefined),withNativeDatabaseConnection:jest.fn().mockResolvedValue([[]]),executeMysql:jest.fn().mockResolvedValue(undefined),restoreSql:jest.fn().mockResolvedValue(undefined),verifyRestore:jest.fn().mockResolvedValue({status:'passed',details:[{name:'items'}]})});
    return instance;
  }
  it('validates rewritten SQL before creating scratch and preserves cleanup failure', async () => {
    const instance = adapter(); instance.executeMysql.mockImplementation(async (_connection: any,sql: string) => { if (sql.startsWith('DROP')) throw new Error('drop denied'); });
    const result = await instance.restoreArtifactForRehearsal('run','recovery');
    expect(result.cleanupWarnings).toEqual([expect.stringContaining('drop denied')]);
    expect(instance.validatePitrSqlFile).toHaveBeenCalledTimes(2);
    expect(instance.validatePitrSqlFile.mock.invocationCallOrder[1]).toBeLessThan(instance.executeMysql.mock.invocationCallOrder[0]);
    expect(result.databaseMap.db).toMatch(/^vb_rehearsal_/);
  });
  it('hash/unsafe SQL failure never creates or imports a database', async () => {
    const instance = adapter(); instance.stageAndVerifyDownload.mockRejectedValue(new Error('Hash mismatch'));
    await expect(instance.restoreArtifactForRehearsal('run','recovery')).rejects.toThrow('Hash mismatch');
    expect(instance.executeMysql).not.toHaveBeenCalled(); expect(instance.restoreSql).not.toHaveBeenCalled();
    instance.stageAndVerifyDownload.mockResolvedValue({path:path.join(directory,'fixture.sql'),cleanup:false}); instance.validatePitrSqlFile.mockRejectedValue(new Error('unsafe cross-database statement'));
    await expect(instance.restoreArtifactForRehearsal('run','recovery')).rejects.toThrow('unsafe'); expect(instance.executeMysql).not.toHaveBeenCalled();
  });
  it('scratch collision never overwrites or cleans a database it did not create', async () => {
    const instance = adapter(); let names: string[] = [];
    instance.withNativeDatabaseConnection.mockImplementation(async () => [names.map(Database => ({Database}))]);
    await expect(instance.restoreArtifactForRehearsal('run','recovery',(evidence: any) => { if (evidence.databaseMap) names = Object.values(evidence.databaseMap); })).rejects.toThrow('collision');
    expect(instance.executeMysql).not.toHaveBeenCalled(); expect(instance.restoreSql).not.toHaveBeenCalled();
  });
  it('cleanup proceeds when recording its progress fails', async () => {
    const instance = adapter();
    const result = await instance.restoreArtifactForRehearsal('run','recovery',(evidence: any) => { if (evidence.stage === 'cleaning-up') throw new Error('disk full'); });
    expect(instance.executeMysql.mock.calls.some((call: any[]) => call[1].startsWith('DROP DATABASE'))).toBe(true);
    expect(result.cleanupWarnings).toEqual([expect.stringContaining('disk full')]);
  });
  it('preserves UTF-8 characters split across file chunks while rewriting', async () => {
    const instance = adapter();
    instance.executionPipeline = require('node:stream/promises').pipeline;
    instance.temporaryFileLimitBytes = () => 10 * 1024 * 1024;
    const input = path.join(directory,'utf8.sql'); const output = path.join(directory,'utf8-mapped.sql');
    const prefix = "USE `db`; INSERT INTO `items` VALUES ('";
    const sql = prefix + 'a'.repeat(65535 - Buffer.byteLength(prefix)) + "😀漢字');";
    fs.writeFileSync(input,sql);
    await BackupService.prototype['rewritePitrSqlFile'].call(instance,input,{db:'scratch'},output);
    expect(fs.readFileSync(output,'utf8')).toBe(sql.replace('`db`','`scratch`'));
  });
  it('disables native client commands for all SQL file imports', async () => {
    const instance: any = Object.create(BackupService.prototype); instance.spawnMysql = jest.fn().mockResolvedValue(undefined);
    await instance.restoreSql({engine:'mysql'},'fixture.sql','scratch');
    expect(instance.spawnMysql).toHaveBeenCalledWith({engine:'mysql'},['--binary-mode=1','--database=scratch'],'fixture.sql');
  });
  it('keeps dump comment and string context across validation chunk boundaries', async () => {
    const instance: any = Object.create(BackupService.prototype);
    const file = path.join(directory,'dump-header.sql');
    const header = '-- Server version 11.8.6-MariaDB\n';
    const sql = header + '-- ' + 'fixture comment '.repeat(5000) + '\nUSE `db`; INSERT INTO `items` VALUES (\'11.8.6 fake.other\');\n';
    fs.writeFileSync(file,sql);
    await expect(instance.validatePitrSqlFile(file,['db'])).resolves.toBeUndefined();
    // A 2048-byte tail used to begin in the numeric version comment here.
    fs.writeFileSync(file,'-- Server version 11.8.6-MariaDB\n' + '-- ' + 'x'.repeat(2028) + '\n');
    await expect(instance.validatePitrSqlFile(file,['db'])).resolves.toBeUndefined();
    fs.appendFileSync(file,'\nUPDATE `outside`.`items` SET id=1;');
    await expect(instance.validatePitrSqlFile(file,['db'])).rejects.toThrow();
  });
});
