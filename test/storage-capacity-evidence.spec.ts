import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../src/database/database.service';
import { StorageService } from '../src/storage/storage.service';

describe('persisted destination capacity evidence', () => {
  let directory: string; let previous: string | undefined; let store: DatabaseService; let storage: StorageService;
  beforeEach(async () => {
    previous = process.env.DATA_DIR; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultback-capacity-'));
    process.env.DATA_DIR = directory; store = new DatabaseService(); await store.onModuleInit();
    storage = new StorageService(store, { publish: jest.fn() } as any);
  });
  afterEach(async () => {
    await store.onModuleDestroy();
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it('returns the sampled free bytes and timestamp after reopening the database', async () => {
    const destination = path.join(directory, 'backups', 'fixture'); fs.mkdirSync(destination, { recursive: true });
    const target = storage.save({ name: 'Fixture volume', type: 'local', config: { path: destination } })!;
    const sample = await storage.health(storage.get(target.id));
    expect(Number.isFinite(sample.freeBytes)).toBe(true);
    await store.onModuleDestroy(); store = new DatabaseService(); await store.onModuleInit();
    const reopened = new StorageService(store, { publish: jest.fn() } as any);
    expect(reopened.healthSummary()[0]).toMatchObject({ freeBytes: sample.freeBytes, checkedAt: sample.checkedAt });
  });
  it('keeps unsupported provider capacity unknown and clears prior bytes on a failed check', async () => {
    const target = storage.save({ name: 'Provider fixture', type: 'ftp', config: { host: 'example.invalid' } })!;
    const test = jest.spyOn(storage, 'test').mockResolvedValue({ ok: true, message: 'Fixture accepted' });
    await storage.health(storage.get(target.id));
    expect(storage.healthSummary()[0]).toMatchObject({ freeBytes: null });
    test.mockRejectedValue(new Error('Fixture unavailable'));
    await expect(storage.health(storage.get(target.id))).rejects.toThrow('Fixture unavailable');
    expect(storage.healthSummary()[0]).toMatchObject({ status: 'unavailable', freeBytes: null });
  });
});
