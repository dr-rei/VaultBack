import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupService } from '../src/backup/backup.service';
import { DatabaseService } from '../src/database/database.service';

describe('backup runs page summary', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let store: DatabaseService;
  let backups: BackupService;

  beforeEach(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultback-runs-page-'));
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
  });

  it('returns status totals independently of the visible page size', () => {
    const job = backups.saveJobV2({
      name: 'Nightly',
      connectionIds: ['connection'],
      storageTargetIds: ['storage'],
      databaseScope: 'selected',
      databaseSelections: [{ connectionId: 'connection', databases: ['sample'] }],
      cronExpression: '0 2 * * *'
    });
    const addRun = store.db.prepare('INSERT INTO backup_runs (id,job_id,status,started_at,attempt) VALUES (?,?,?,?,?)');
    for (let index = 0; index < 12; index += 1) {
      addRun.run(`running-${index}`, job.id, 'running', `2026-10-13T00:${String(index).padStart(2, '0')}:00.000Z`, 1);
    }
    addRun.run('success-one', job.id, 'success', '2026-10-13T00:12:00.000Z', 1);

    const page = backups.runsPage({ page: 1, pageSize: 10 });
    expect(page.items).toHaveLength(10);
    expect(page).toMatchObject({ total: 13, successTotal: 1, failedTotal: 0, attentionTotal: 0, runningTotal: 12 });

    const filtered = backups.runsPage({ status: 'success' });
    expect(filtered).toMatchObject({ total: 1, successTotal: 1, runningTotal: 0 });
  });
});
