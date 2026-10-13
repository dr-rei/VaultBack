import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BackupService } from '../src/backup/backup.service';
import { DatabaseService } from '../src/database/database.service';
import { DatabaseConnection } from '../src/types';

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawn: jest.fn()
}));

describe('backup schedule INSERT style', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let store: DatabaseService;
  let backups: BackupService;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultback-insert-mode-'));
    process.env.DATA_DIR = dataDir;
    store = new DatabaseService();
    await store.onModuleInit();
    backups = new BackupService(store, {} as any, {} as any, {} as any);
    store.db.prepare('INSERT INTO database_connections (id,name,engine,host,port,username,password_enc,database_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('connection', 'Test database', 'mysql', '127.0.0.1', 3306, 'tester', store.encrypt(''), 'sample', store.now());
    store.db.prepare('INSERT INTO storage_targets (id,name,type,config_enc,created_at) VALUES (?,?,?,?,?)')
      .run('storage', 'Local', 'local', store.encrypt({ path: dataDir }), store.now());
  });

  afterEach(() => {
    store.onModuleDestroy();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('persists the setting on create and edit', () => {
    const input = {
      name: 'Nightly',
      connectionIds: ['connection'],
      storageTargetIds: ['storage'],
      databaseScope: 'selected',
      databaseSelections: [{ connectionId: 'connection', databases: ['sample'] }],
      cronExpression: '0 2 * * *',
      insertMode: 'single-row'
    };
    const created = backups.saveJobV2(input);
    expect(created.insertMode).toBe('single-row');
    expect(backups.listJobsPageV2().items[0].insertMode).toBe('single-row');

    const { insertMode: _insertMode, ...legacyEdit } = input;
    expect(backups.saveJobV2({ ...legacyEdit, id: created.id }).insertMode).toBe('single-row');

    const updated = backups.saveJobV2({ ...input, id: created.id, insertMode: 'extended' });
    expect(updated.insertMode).toBe('extended');
    expect(store.db.prepare('SELECT insert_mode as insertMode FROM backup_jobs WHERE id=?').get(created.id))
      .toMatchObject({ insertMode: 'extended' });
  });

  it('defaults older schedules to grouped inserts during migration', () => {
    const created = backups.saveJobV2({
      name: 'Legacy',
      connectionIds: ['connection'],
      storageTargetIds: ['storage'],
      databaseScope: 'selected',
      databaseSelections: [{ connectionId: 'connection', databases: ['sample'] }],
      cronExpression: '0 2 * * *'
    });
    store.db.exec('ALTER TABLE backup_jobs DROP COLUMN insert_mode');
    (store as any).migrate();
    expect(store.db.prepare('SELECT insert_mode as insertMode FROM backup_jobs WHERE id=?').get(created.id))
      .toMatchObject({ insertMode: 'extended' });
  });

  it('passes the single-row flag to every data dump layout', async () => {
    const mockedSpawn = spawn as jest.Mock;
    mockedSpawn.mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = Readable.from([]);
      child.stderr = Readable.from([]);
      child.stdout.on('end', () => setImmediate(() => child.emit('close', 0)));
      return child;
    });
    const service = backups as any;
    service.resolveClientBinary = () => 'mysqldump';
    service.clientToolArgs = () => ['--no-defaults'];
    const connection = {
      engine: 'mysql', host: '127.0.0.1', port: 3306, username: 'tester',
      password: '', ssl: false, databaseScope: 'selected', databases: ['sample']
    } as DatabaseConnection;

    await service.dump(connection, path.join(dataDir, 'single.sql'), undefined, 'single-row');
    await service.dumpDatabase(connection, 'sample', path.join(dataDir, 'database.sql'), undefined, 'single-row');
    await service.dumpTable(connection, 'sample', 'items', path.join(dataDir, 'table.sql'), undefined, true, 'single-row');
    expect(mockedSpawn).toHaveBeenCalledTimes(3);
    for (const [, args] of mockedSpawn.mock.calls) expect(args).toContain('--skip-extended-insert');

    await service.dump(connection, path.join(dataDir, 'extended.sql'), undefined, 'extended');
    expect(mockedSpawn.mock.calls[3][1]).not.toContain('--skip-extended-insert');
    expect(mockedSpawn.mock.calls[3][1]).toContain('--skip-ssl');

    service.resolveClientBinary = () => path.join(process.cwd(), 'tools', 'mysql', 'win32-x64', 'bin', 'mysqldump.exe');
    await service.dump(connection, path.join(dataDir, 'mysql-no-ssl.sql'), undefined, 'single-row');
    expect(mockedSpawn.mock.calls[4][1]).toContain('--ssl-mode=DISABLED');
    expect(mockedSpawn.mock.calls[4][1]).not.toContain('--skip-ssl');
    await service.dump({ ...connection, ssl: true }, path.join(dataDir, 'mysql-ssl.sql'), undefined, 'single-row');
    expect(mockedSpawn.mock.calls[5][1]).toContain('--ssl-mode=REQUIRED');
  });
});
