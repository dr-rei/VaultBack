import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BackupService } from '../src/backup/backup.service';
import { DatabaseService } from '../src/database/database.service';
import { RecoveryService } from '../src/recovery/recovery.service';

jest.mock('node:child_process', () => ({ ...jest.requireActual('node:child_process'), spawn: jest.fn() }));

describe('PITR and restore safety workflows', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let previousMysqlBinlogPath: string | undefined;
  let store: DatabaseService;
  let backups: BackupService;
  let storage: any;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    previousMysqlBinlogPath = process.env.MYSQL_BINLOG_PATH;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultback-pitr-'));
    process.env.DATA_DIR = dataDir;
    store = new DatabaseService();
    await store.onModuleInit();
    storage = { get: jest.fn(id => ({ id })), download: jest.fn(), rotate: jest.fn(), immutabilityStatus: jest.fn(() => ({ providerEnforced: false, configured: false, message: 'Not enabled' })) };
    backups = new BackupService(store, storage, {} as any, {} as any);
    store.db.prepare('INSERT INTO database_connections (id,name,engine,host,port,username,password_enc,database_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('connection', 'Source', 'mysql', '127.0.0.1', 3306, 'tester', store.encrypt(''), 'sample', store.now());
    store.db.prepare('INSERT INTO storage_targets (id,name,type,config_enc,created_at) VALUES (?,?,?,?,?)')
      .run('storage', 'Local', 'local', store.encrypt({ path: dataDir }), store.now());
  });

  afterEach(() => {
    store.onModuleDestroy();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousMysqlBinlogPath === undefined) delete process.env.MYSQL_BINLOG_PATH;
    else process.env.MYSQL_BINLOG_PATH = previousMysqlBinlogPath;
    fs.rmSync(dataDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function addJob(name = 'Nightly') {
    return backups.saveJobV2({
      name,
      connectionIds: ['connection'],
      storageTargetIds: ['storage'],
      databaseScope: 'selected',
      databaseSelections: [{ connectionId: 'connection', databases: ['sample'] }],
      cronExpression: '0 2 * * *'
    });
  }

  it('uses a configured native MySQL binlog utility only for MySQL', () => {
    const binaryName = process.platform === 'win32' ? 'mysqlbinlog.exe' : 'mysqlbinlog';
    const binary = path.join(dataDir, binaryName);
    fs.writeFileSync(binary, 'test executable path');
    process.env.MYSQL_BINLOG_PATH = binary;
    expect((backups as any).resolveBinlogBinary('mysql')).toBe(binary);
    expect((backups as any).isNativeMysqlBinlog('mysql', binary)).toBe(true);
    expect((backups as any).isNativeMysqlBinlog('mariadb', binary)).toBe(false);
  });

  it('keeps scheduled PITR capture errors visible before continuity is established', async () => {
    const job = addJob();
    store.db.prepare('INSERT INTO pitr_sources (connection_id,storage_target_id,enabled,capture_interval_minutes,checkpoint_json,gap_status,message,base_job_id) VALUES (?,?,?,?,?,?,?,?)')
      .run('connection', 'storage', 1, 1, '{}', 'gap', 'mysqlbinlog rejected the server version', job.id);
    jest.spyOn(backups, 'inspectPitr').mockResolvedValue({ status: 'ready', message: 'Binary logging is enabled', binaryLogging: true, binlogFormat: 'ROW', gtid: null, logCount: 1, earliestLog: 'mysql-bin.000001', latestLog: 'mysql-bin.000001' } as any);
    const recovery = new RecoveryService(store, backups, storage, {} as any);
    const status = await recovery.pitrStatus();
    expect(status.items[0]).toMatchObject({ status: 'gap', message: 'mysqlbinlog rejected the server version' });
  });

  it('adds migration-safe PITR metadata and work claims without losing existing runs', () => {
    const job = addJob();
    store.db.prepare('INSERT INTO backup_runs (id,job_id,status,started_at,attempt) VALUES (?,?,?,?,?)').run('run-preserved', job.id, 'success', store.now(), 1);
    store.db.exec('ALTER TABLE backup_runs DROP COLUMN pitr_coordinate_at');
    store.db.exec('DROP TABLE pitr_rehearsals');

    (store as any).migrate();
    expect(store.db.prepare('SELECT status FROM backup_runs WHERE id=?').get('run-preserved')).toMatchObject({ status: 'success' });
    expect(store.db.prepare('PRAGMA table_info(backup_runs)').all().map((column: any) => column.name)).toContain('pitr_coordinate_at');
    expect(store.db.prepare('PRAGMA table_info(backup_runs)').all().map((column: any) => column.name)).toContain('expected_objects');
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pitr_rehearsals'").get()).toBeTruthy();
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_claims'").get()).toBeTruthy();
  });

  it('serializes claims across service instances and releases them for a later run', async () => {
    const store2 = new DatabaseService();
    await store2.onModuleInit();
    const backups2 = new BackupService(store2, storage, {} as any, {} as any);
    const first = (backups as any).acquireWorkClaim('backup:job', 'claimed');
    expect(() => (backups2 as any).acquireWorkClaim('backup:job', 'claimed')).toThrow('claimed');
    (backups as any).releaseWorkClaim('backup:job', first);
    const second = (backups2 as any).acquireWorkClaim('backup:job', 'claimed');
    expect(second).toBeTruthy();
    (backups2 as any).releaseWorkClaim('backup:job', second);
    store2.onModuleDestroy();
  });

  it('returns per-source results and marks an aggregate multi-source run failed when one pair fails', async () => {
    store.db.prepare('INSERT INTO database_connections (id,name,engine,host,port,username,password_enc,database_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('connection-two', 'Second source', 'mysql', '127.0.0.2', 3306, 'tester', store.encrypt(''), 'sample', store.now());
    const job = backups.saveJobV2({
      name: 'Multi-source',
      connectionIds: ['connection', 'connection-two'],
      storageTargetIds: ['storage'],
      databaseScope: 'selected',
      databaseSelections: [{ connectionId: 'connection', databases: ['sample'] }, { connectionId: 'connection-two', databases: ['sample'] }],
      cronExpression: '0 2 * * *'
    });
    jest.spyOn(backups as any, 'run').mockImplementation(async (_jobId, _attempt, connectionId) => {
      if (connectionId === 'connection') return { ok: true, id: 'run-one' };
      throw new Error('second source unavailable');
    });

    const result = await (backups as any).runConfiguredJob(job.id);
    expect(result).toMatchObject({ ok: false, completed: 1, failed: 1 });
    expect(result.results).toEqual([
      { connectionId: 'connection', storageTargetId: 'storage', ok: true, runId: 'run-one' },
      { connectionId: 'connection-two', storageTargetId: 'storage', ok: false, error: 'second source unavailable' }
    ]);
  });

  it('builds policy findings from each run recorded source and storage pair', () => {
    store.db.prepare('INSERT INTO database_connections (id,name,engine,host,port,username,password_enc,database_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('connection-two', 'Second source', 'mysql', '127.0.0.2', 3306, 'tester', store.encrypt(''), 'sample', store.now());
    store.db.prepare('INSERT INTO storage_targets (id,name,type,config_enc,created_at) VALUES (?,?,?,?,?)')
      .run('storage-two', 'Second target', 'local', store.encrypt({ path: dataDir }), store.now());
    const job = backups.saveJobV2({
      name: 'Multi-source policy', connectionIds: ['connection', 'connection-two'], storageTargetIds: ['storage'], databaseScope: 'selected',
      databaseSelections: [{ connectionId: 'connection', databases: ['sample'] }, { connectionId: 'connection-two', databases: ['sample'] }], cronExpression: '0 2 * * *'
    });
    const insertRun = store.db.prepare(`INSERT INTO backup_runs (id,job_id,status,started_at,finished_at,filename,storage_target_id,database_connection_id,database_names,database_scope,backup_layout,backup_objects,expected_objects,compression,backup_encryption,insert_mode,connection_engine)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insertRun.run('run-source-one', job.id, 'success', store.now(), store.now(), 'one.sql.gz', 'storage', 'connection', '["sample"]', 'selected', 'single', '{}', '{"sample":["items"]}', 'gzip', 'none', 'extended', 'mysql');
    insertRun.run('run-source-two', job.id, 'success', store.now(), store.now(), 'two.sql.gz', 'storage-two', 'connection-two', '["sample"]', 'selected', 'single', '{}', '{"sample":["items"]}', 'gzip', 'none', 'extended', 'mysql');
    const recovery = new RecoveryService(store, backups, storage, {} as any);

    const items = recovery.policy().items;
    expect(items).toHaveLength(2);
    expect(items.map(item => [item.runId, item.connectionName, item.storageName]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))).toEqual([
      ['run-source-one', 'Source', 'Local'],
      ['run-source-two', 'Second source', 'Second target']
    ]);
    expect(items.every(item => item.metadata?.metadataComplete)).toBe(true);
  });

  it('rejects a changed backup before invoking restore', async () => {
    const job = addJob();
    const content = path.join(dataDir, 'changed.sql');
    fs.writeFileSync(content, 'SELECT 1;');
    storage.download.mockResolvedValue({ path: content, cleanup: false });
    store.db.prepare(`INSERT INTO backup_runs (id,job_id,status,started_at,filename,storage_target_id,database_connection_id,database_names,database_scope,backup_layout,backup_objects,expected_objects,compression,backup_encryption,insert_mode,connection_engine,sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('run-hash', job.id, 'success', store.now(), 'backup.sql', 'storage', 'connection', '["sample"]', 'selected', 'single', '{}', '{"sample":["items"]}', 'none', 'none', 'extended', 'mysql', '0'.repeat(64));
    const restoreSql = jest.spyOn(backups as any, 'restoreSql');

    await expect(backups.restoreRun('run-hash', { connectionId: 'connection', mode: 'overwrite', overwriteConfirmed: true }))
      .rejects.toThrow(/SHA-256 verification failed/);
    expect(restoreSql).not.toHaveBeenCalled();
  });

  it('requires and verifies every recorded table or view object after restore', async () => {
    const query = jest.fn(async (sql: string) => sql === 'SHOW DATABASES' ? [[{ Database: 'sample' }]] : [[{ tableName: 'items' }]]);
    jest.spyOn(backups as any, 'withNativeDatabaseConnection').mockImplementation(async (_connection: any, action: any) => action({ query }));

    expect(() => (backups as any).parseExpectedObjects('', ['sample'])).toThrow(/no verifiable table-object expectation/);
    await expect((backups as any).verifyRestore({ id: 'recovery' }, ['sample'], { sample: ['items'] }))
      .resolves.toMatchObject({ status: 'passed', details: [{ database: 'sample', expectedObjects: ['items'], missingObjects: [] }] });

    query.mockImplementation(async (sql: string) => sql === 'SHOW DATABASES' ? [[{ Database: 'sample' }]] : [[]]);
    await expect((backups as any).verifyRestore({ id: 'recovery' }, ['sample'], { sample: ['items'] }))
      .resolves.toMatchObject({ status: 'failed', message: expect.stringContaining('missing expected tables or views: items') });
  });

  it('validates a manifest against the run and rejects unsafe ZIP paths', async () => {
    const sql = path.join(dataDir, 'sample.sql');
    fs.writeFileSync(sql, 'CREATE TABLE `sample`.`items` (`id` int);');
    const manifestEntries = (backups as any).addBackupManifest([{ name: 'sample/sample.sql', path: sql }], dataDir, 'database', 'selected', ['sample']);
    const zip = path.join(dataDir, 'valid.zip');
    await (backups as any).writeZip(manifestEntries, zip);
    const row = { backupLayout: 'database', databaseScope: 'selected' };
    expect((backups as any).validatedZipSqlEntries(zip, row, ['sample']).map((entry: any) => entry.name)).toEqual(['sample/sample.sql']);
    expect(() => (backups as any).validatedZipSqlEntries(zip, row, ['other'])).toThrow(/manifest database list/);

    const unsafe = path.join(dataDir, 'unsafe.zip');
    await (backups as any).writeZip([{ name: '../escape.sql', path: sql }], unsafe);
    expect(() => (backups as any).readZipEntries(unsafe)).toThrow(/unsafe/);
  });

  it('does not drop a colliding recovery database and preserves cleanup failure evidence', async () => {
    const execute = jest.spyOn(backups as any, 'executeMysql').mockRejectedValue(new Error('drop denied'));
    jest.spyOn(backups as any, 'getConnection').mockReturnValue({ id: 'recovery' });
    jest.spyOn(backups as any, 'restoreRun').mockImplementation(async (_runId: any, input: any) => {
      expect(input.databaseName).toMatch(/^vb_test_[a-f0-9]{32}$/);
      throw new Error('Database already exists');
    });
    await expect(backups.restoreRunForRecoveryTest('run', 'recovery', 'vb_test_0123456789abcdef0123456789abcdef'))
      .rejects.toThrow(/Database already exists/);
    expect(execute).not.toHaveBeenCalled();

    (backups as any).restoreRun.mockImplementation(async (_runId: string, input: any) => {
      input._createdDatabases.push(input.databaseName);
      throw new Error('Import failed');
    });
    await expect(backups.restoreRunForRecoveryTest('run', 'recovery', 'vb_test_0123456789abcdef0123456789abcdef'))
      .rejects.toThrow(/cleanup also failed/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('uses run-level expectations rather than current schedule settings', async () => {
    const bytes = Buffer.from('archive contents');
    const file = path.join(dataDir, 'hash.sql');
    fs.writeFileSync(file, bytes);
    const expected = crypto.createHash('sha256').update(bytes).digest('hex');
    await expect((backups as any).verifyDownloadedHash(file, expected, true)).resolves.toMatchObject({ verified: true });
    await expect((backups as any).verifyDownloadedHash(file, 'not-a-hash', true)).rejects.toThrow(/recorded backup SHA-256 is invalid/);
  });

  it('stages local artifacts before verified restore and cannot disable restore verification', async () => {
    const job = addJob();
    const content = Buffer.from('CREATE TABLE `sample`.`items` (`id` int);');
    const file = path.join(dataDir, 'local-restore.sql');
    fs.writeFileSync(file, content);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    storage.download.mockResolvedValue({ path: file, cleanup: false });
    store.db.prepare(`INSERT INTO backup_runs (id,job_id,status,started_at,filename,storage_target_id,database_connection_id,database_names,database_scope,backup_layout,backup_objects,expected_objects,compression,backup_encryption,insert_mode,connection_engine,sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('run-restore-verify', job.id, 'success', store.now(), 'backup.sql', 'storage', 'connection', '["sample"]', 'selected', 'single', '{}', '{"sample":["items"]}', 'none', 'none', 'extended', 'mysql', hash);
    (backups as any).system.notify = jest.fn();
    const restoreSql = jest.spyOn(backups as any, 'restoreSql').mockResolvedValue(undefined);
    const verifyRestore = jest.spyOn(backups as any, 'verifyRestore').mockResolvedValue({ status: 'passed', message: 'Verified', details: {} });

    await backups.restoreRun('run-restore-verify', { connectionId: 'connection', mode: 'overwrite', overwriteConfirmed: true, verifyAfterRestore: false });

    expect(restoreSql).toHaveBeenCalledTimes(1);
    expect(restoreSql.mock.calls[0][1]).not.toBe(file);
    expect(fs.existsSync(restoreSql.mock.calls[0][1] as string)).toBe(false);
    expect(verifyRestore).toHaveBeenCalledWith(expect.anything(), ['sample'], { sample: ['items'] });
  });

  it('keeps staged-download cleanup failures in PITR rehearsal evidence', async () => {
    const job = backups.saveJobV2({
      name: 'PITR baseline', connectionIds: ['connection'], storageTargetIds: ['storage'], databaseScope: 'all',
      databaseSelections: [{ connectionId: 'connection', databases: [] }], backupLayout: 'single',
      backupObjects: { views: true, routines: true, triggers: true, events: true }, cronExpression: '0 2 * * *'
    });
    const targetTime = new Date(Date.now() - 2_000).toISOString();
    const coordinateAt = new Date(Date.now() - 10_000).toISOString();
    store.db.prepare('INSERT INTO database_connections (id,name,engine,host,port,username,password_enc,database_name,connection_purpose,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('recovery', 'Recovery', 'mysql', '127.0.0.2', 3306, 'tester', store.encrypt(''), 'mysql', 'recovery', store.now());
    store.db.prepare(`INSERT INTO backup_runs (id,job_id,status,started_at,finished_at,filename,storage_target_id,database_connection_id,database_names,database_scope,backup_layout,backup_objects,expected_objects,compression,backup_encryption,insert_mode,connection_engine,sha256,pitr_log_file,pitr_log_position,pitr_coordinate_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('baseline-cleanup', job.id, 'success', store.now(), store.now(), 'baseline.sql', 'storage', 'connection', '["sample"]', 'all', 'single', JSON.stringify({ views: true, routines: true, triggers: true, events: true }), '{"sample":["items"]}', 'none', 'none', 'extended', 'mysql', 'a'.repeat(64), 'mysql-bin.000001', 154, coordinateAt);
    store.db.prepare(`INSERT INTO pitr_sources (connection_id,storage_target_id,enabled,capture_interval_minutes,checkpoint_json,gap_status,last_continuous_at,base_job_id)
      VALUES (?,?,?,?,?,?,?,?)`).run('connection', 'storage', 1, 15, JSON.stringify({ baselineRunId: 'baseline-cleanup', visibleLogs: ['mysql-bin.000001'] }), 'continuous', new Date(Date.now() + 60_000).toISOString(), job.id);
    store.db.prepare(`INSERT INTO pitr_artifacts (id,connection_id,storage_target_id,binlog_name,storage_folder,size_bytes,sha256,captured_at,status,capture_kind,log_position,log_size)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('artifact-cleanup', 'connection', 'storage', 'mysql-bin.000001', 'pitr', 5, 'b'.repeat(64), store.now(), 'captured', 'scheduled', 4, 5);
    store.db.prepare(`INSERT INTO pitr_rehearsals (id,connection_id,backup_run_id,recovery_connection_id,target_time,status,progress,stage,started_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run('rehearsal-cleanup', 'connection', 'baseline-cleanup', 'recovery', targetTime, 'running', 1, 'queued', store.now());
    const baseline = path.join(dataDir, 'baseline.sql');
    const log = path.join(dataDir, 'mysql-bin.000001');
    fs.writeFileSync(baseline, 'CREATE TABLE `sample`.`items` (`id` int);');
    fs.writeFileSync(log, 'binary log');
    const baselineHash = crypto.createHash('sha256').update(fs.readFileSync(baseline)).digest('hex');
    const logHash = crypto.createHash('sha256').update(fs.readFileSync(log)).digest('hex');
    store.db.prepare('UPDATE backup_runs SET sha256=? WHERE id=?').run(baselineHash, 'baseline-cleanup');
    store.db.prepare('UPDATE pitr_artifacts SET sha256=? WHERE id=?').run(logHash, 'artifact-cleanup');
    storage.download.mockImplementation(async (_target: any, filename: string) => ({ path: filename === 'baseline.sql' ? baseline : log, cleanup: false }));
    (backups as any).realtime.publish = jest.fn();
    jest.spyOn(backups as any, 'getConnection').mockImplementation((id: unknown) => ({ id: String(id), engine: 'mysql', host: '127.0.0.1', port: 3306, username: 'tester', password: '', ssl: false }));
    jest.spyOn(backups as any, 'resolveBinlogBinary').mockReturnValue('mysqlbinlog');
    jest.spyOn(backups as any, 'executableAvailable').mockReturnValue(true);
    jest.spyOn(backups as any, 'decodeBinlogs').mockRejectedValue(new Error('decode failed'));
    const rmSync = fs.rmSync;
    jest.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options?: fs.RmOptions) => {
      if (String(target).includes('verified-download-')) throw new Error('cleanup denied');
      return rmSync(target, options);
    }) as typeof fs.rmSync);

    await (backups as any).performPitrRehearsal('rehearsal-cleanup');

    const rehearsal = backups.getPitrRehearsal('rehearsal-cleanup');
    expect(rehearsal.status).toBe('failed_with_cleanup_warning');
    expect(rehearsal.evidence.cleanup.failures).toEqual(expect.arrayContaining([
      expect.stringContaining('temporary download'),
      expect.stringContaining('cleanup denied')
    ]));
  });

  it('captures ordered binlogs, versions active-log files, and records continuous coverage', async () => {
    const job = backups.saveJobV2({
      name: 'PITR baseline', connectionIds: ['connection'], storageTargetIds: ['storage'], databaseScope: 'all',
      databaseSelections: [{ connectionId: 'connection', databases: [] }], backupLayout: 'single', backupObjects: { views: true, routines: true, triggers: true, events: true }, cronExpression: '0 2 * * *'
    });
    store.db.prepare(`INSERT INTO backup_runs (id,job_id,status,started_at,finished_at,filename,storage_target_id,database_connection_id,database_names,database_scope,backup_layout,backup_objects,expected_objects,compression,backup_encryption,insert_mode,connection_engine,sha256,pitr_log_file,pitr_log_position,pitr_coordinate_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('baseline-run', job.id, 'success', store.now(), store.now(), 'baseline.sql.gz', 'storage', 'connection', '["sample"]', 'all', 'single', JSON.stringify({ views: true, routines: true, triggers: true, events: true }), '{"sample":["items"]}', 'gzip', 'none', 'extended', 'mysql', 'a'.repeat(64), 'mysql-bin.000001', 154, store.now());
    store.db.prepare(`INSERT INTO pitr_sources (connection_id,storage_target_id,enabled,capture_interval_minutes,base_job_id,next_capture_at,gap_status,message)
      VALUES (?,?,?,?,?,?,?,?)`).run('connection', 'storage', 1, 15, job.id, store.now(), 'unknown', 'Waiting for capture');
    storage.upload = jest.fn(async (_target, source, filename, folder) => ({ location: `${folder}/${filename}` }));
    jest.spyOn(backups as any, 'getConnection').mockReturnValue({ id: 'connection', engine: 'mysql', host: '127.0.0.1', port: 3306, username: 'tester', password: '', ssl: false });
    jest.spyOn(backups as any, 'inspectPitr').mockResolvedValue({ binaryLogging: true, latestLog: 'mysql-bin.000002' });
    jest.spyOn(backups as any, 'resolveBinlogBinary').mockReturnValue('mysqlbinlog');
    jest.spyOn(backups as any, 'clientToolArgs').mockReturnValue([]);
    jest.spyOn(backups as any, 'withNativeDatabaseConnection').mockImplementation(async (_connection: any, callback: any) => callback({
      query: async () => [[{ Log_name: 'mysql-bin.000001', File_size: 50 }, { Log_name: 'mysql-bin.000002', File_size: 100 }]]
    }));
    const mockedSpawn = spawn as jest.Mock;
    mockedSpawn.mockImplementation((_binary, args: string[]) => {
      const prefix = args.find(arg => arg.startsWith('--result-file='))!.slice('--result-file='.length);
      const logs = args.filter(arg => /^mysql-bin\.\d+$/.test(arg));
      for (const log of logs) fs.writeFileSync(`${prefix}${log}`, Buffer.from(`raw:${log}`));
      const child = new EventEmitter() as any;
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });

    const first = await backups.capturePitr('connection', 'storage', true);
    expect(first).toMatchObject({ ok: true, status: 'continuous', captured: 2 });
    await new Promise(resolve => setTimeout(resolve, 2));
    const second = await backups.capturePitr('connection', 'storage', true);
    expect(second).toMatchObject({ ok: true, status: 'continuous', captured: 1 });
    const artifacts = store.db.prepare("SELECT binlog_name as name,capture_id as captureId,status FROM pitr_artifacts WHERE connection_id=? AND capture_kind='scheduled' ORDER BY captured_at").all('connection') as any[];
    expect(artifacts).toHaveLength(3);
    expect(artifacts.filter(item => item.name === 'mysql-bin.000002')).toHaveLength(2);
    expect(artifacts.every(item => item.status === 'captured' && item.captureId)).toBe(true);
    expect(store.db.prepare('SELECT gap_status as gapStatus,last_continuous_at as lastContinuousAt FROM pitr_sources WHERE connection_id=?').get('connection')).toMatchObject({ gapStatus: 'continuous' });
  });
});
