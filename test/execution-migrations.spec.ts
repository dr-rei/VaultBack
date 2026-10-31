import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { DatabaseService } from '../src/database/database.service';

describe('execution persistence migration', () => {
  let directory: string; let previous: string | undefined; let store: DatabaseService;
  beforeEach(async () => {
    previous = process.env.DATA_DIR;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultback-migration-'));
    process.env.DATA_DIR = directory; store = new DatabaseService(); await store.onModuleInit();
  });
  afterEach(() => {
    store.onModuleDestroy();
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it('migrates repeatedly without changing encrypted credentials or legacy runs', async () => {
    const encrypted = store.encrypt('secret-fixture');
    store.db.prepare('INSERT INTO database_connections(id,name,engine,host,port,username,password_enc,database_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('c','c','mysql','localhost',3306,'u',encrypted,'db',store.now());
    store.db.prepare('INSERT INTO backup_runs(id,job_id,status,started_at) VALUES (?,?,?,?)').run('legacy','legacy-job','success',store.now());
    store.onModuleDestroy(); store = new DatabaseService(); await store.onModuleInit();
    expect(store.decrypt(store.db.prepare('SELECT password_enc FROM database_connections').get()!.password_enc as string)).toBe('secret-fixture');
    expect(store.db.prepare('SELECT execution_id FROM backup_runs WHERE id = ?').get('legacy')).toEqual({ execution_id: null });
    expect(store.db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('notification_outbox')).toBeDefined();
  });
  it('backs up existing bytes once before execution schema upgrade', async () => {
    store.db.exec('DROP TABLE backup_executions');
    store.onModuleDestroy();
    const original = fs.readFileSync(path.join(directory, 'vaultback.sqlite'));
    store = new DatabaseService(); await store.onModuleInit();
    const backup = path.join(directory, 'vaultback.sqlite.before-executions.bak');
    expect(fs.readFileSync(backup)).toEqual(original);
    store.onModuleDestroy(); store = new DatabaseService(); await store.onModuleInit();
    expect(fs.readFileSync(backup)).toEqual(original);
  });
  it('releases ownership after initialization fails', async () => {
    store.onModuleDestroy();
    const file = path.join(directory, 'vaultback.sqlite'); const original = fs.readFileSync(file);
    fs.writeFileSync(file, 'invalid sqlite fixture');
    const failed = new DatabaseService(); await expect(failed.onModuleInit()).rejects.toThrow();
    fs.writeFileSync(file, original);
    store = new DatabaseService(); await store.onModuleInit();
  });
  it('rolls back memory and preserves readable original bytes on atomic replacement failure', async () => {
    const file = store.databaseFilePath(); const before = fs.readFileSync(file);
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('injected replacement failure'); });
    expect(() => store.db.transaction(() => {
      store.db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?)').run('rollback','fixture');
    })).toThrow('injected');
    rename.mockRestore();
    expect(store.db.prepare('SELECT * FROM app_settings WHERE key = ?').get('rollback')).toBeUndefined();
    expect(fs.readFileSync(file)).toEqual(before);
    const SQL = await initSqlJs(); const original = new SQL.Database(before);
    expect(original.exec('PRAGMA integrity_check')[0].values[0][0]).toBe('ok'); original.close();
    expect(fs.readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('rolls back caught nested failures while committing outer writes once', () => {
    const persist = jest.spyOn(store.db, 'persist');
    store.db.transaction(() => {
      store.db.prepare('INSERT INTO app_settings VALUES (?,?)').run('outer', 'kept');
      expect(() => store.db.transaction(() => {
        store.db.prepare('INSERT INTO app_settings VALUES (?,?)').run('inner', 'discarded');
        throw new Error('inner failed');
      })).toThrow('inner failed');
      store.db.prepare('INSERT INTO app_settings VALUES (?,?)').run('after', 'kept');
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(store.db.prepare('SELECT key FROM app_settings ORDER BY key').all()).toEqual([{ key: 'after' }, { key: 'outer' }]);
  });
  it('rejects async functions before invocation and returned thenables at every depth', async () => {
    let invoked = false;
    const asynchronous = async () => { invoked = true; await Promise.resolve(); store.db.exec("DELETE FROM app_settings"); };
    expect(() => store.db.transaction(asynchronous)).toThrow('synchronous');
    store.db.transaction(() => {
      store.db.prepare('INSERT INTO app_settings VALUES (?,?)').run('outer', 'kept');
      expect(() => store.db.transaction(asynchronous)).toThrow('synchronous');
      expect(() => store.db.transaction(() => {
        store.db.prepare('INSERT INTO app_settings VALUES (?,?)').run('inner', 'discarded');
        return { then: () => undefined };
      })).toThrow('synchronous');
    });
    expect(() => store.db.transaction(() => Promise.resolve())).toThrow('synchronous');
    await Promise.resolve();
    expect(invoked).toBe(false);
    expect(store.db.prepare('SELECT key FROM app_settings').all()).toEqual([{ key: 'outer' }]);
  });
  it('persists a grouped transaction once and rolls back thrown work', () => {
    const persist = jest.spyOn(store.db, 'persist');
    store.db.transaction(() => { store.db.prepare('INSERT INTO app_settings VALUES (?,?)').run('one','1'); store.db.prepare('INSERT INTO app_settings VALUES (?,?)').run('two','2'); });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(() => store.db.transaction(() => { store.db.exec("DELETE FROM app_settings"); throw new Error('stop'); })).toThrow('stop');
    expect(store.db.prepare('SELECT * FROM app_settings').all()).toHaveLength(2);
  });
});
