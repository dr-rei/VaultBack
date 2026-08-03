import { VaultbackHealthIndicator } from '../src/system/health.controller';

describe('VaultbackHealthIndicator', () => {
  it('reports database and encryption status', () => {
    const store = {
      db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
      databaseFilePath: () => 'data/vaultback.sqlite',
      encryptionStatus: () => ({ status: 'ok', checkedRecords: 3, checkedAt: 'now', message: 'Encryption key is valid' })
    } as any;
    const system = { capacity: () => [] } as any;
    const indicator = new VaultbackHealthIndicator(store, system);

    expect(indicator.checkDatabase('database')).toMatchObject({ database: { status: 'up' } });
    expect(indicator.checkEncryption('encryption')).toMatchObject({ encryption: { status: 'up', checkedRecords: 3 } });
  });

  it('reports critical capacity as down', () => {
    const store = { db: { prepare: () => ({ get: () => ({ ok: 1 }) }) } } as any;
    const system = { capacity: () => [{ location: 'data', usedPercent: 97 }] } as any;
    const indicator = new VaultbackHealthIndicator(store, system);

    expect(indicator.checkCapacity('capacity')).toMatchObject({ capacity: { status: 'down' } });
  });
});
