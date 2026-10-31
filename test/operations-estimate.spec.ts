const { estimateNextBackup } = require('../public/operations');

describe('next-backup capacity estimates', () => {
  const now = Date.parse('2026-10-31T00:00:00Z');
  const job = { id: 'job', databaseConnectionIds: ['one', 'two'], databaseScope: 'all', backupLayout: 'single', compression: 'gzip', backupEncryption: 'none', backupObjects: { schema: true, data: true } };
  const health = { status: 'healthy', freeBytes: 1000, checkedAt: new Date(now).toISOString() };
  const runs = ['one', 'two'].map(databaseConnectionId => ({ ...job, jobId: job.id, databaseConnectionId, storageTargetId: 'target', status: 'success', sizeBytes: 100, startedAt: new Date(now).toISOString(), backupObjects: '{"data":true,"schema":true}' }));
  it('sums every source with headroom and normalizes recorded JSON options', () => {
    expect(estimateNextBackup(job, 'target', runs, health, now)).toMatchObject({ status: 'estimated-fit', estimatedBytes: 250 });
  });
  it('flags insufficient capacity without assuming retention savings', () => {
    expect(estimateNextBackup(job, 'target', runs, { ...health, freeBytes: 249 }, now).status).toBe('at-risk');
  });
  it('never treats missing provider capacity as zero or sufficient', () => {
    expect(estimateNextBackup(job, 'target', runs, { ...health, freeBytes: null }, now).status).toBe('unknown');
  });
  it('requires fresh capacity and a matching artifact for every source', () => {
    expect(estimateNextBackup(job, 'target', runs, { ...health, checkedAt: new Date(now - 300001).toISOString() }, now).status).toBe('unknown');
    expect(estimateNextBackup(job, 'target', runs.slice(0, 1), health, now).status).toBe('unknown');
  });
  it('rejects a changed format, other storage, or expired history', () => {
    expect(estimateNextBackup({ ...job, compression: 'none' }, 'target', runs, health, now).status).toBe('unknown');
    expect(estimateNextBackup(job, 'elsewhere', runs, health, now).status).toBe('unknown');
    expect(estimateNextBackup(job, 'target', runs.map((run: any) => ({ ...run, startedAt: new Date(now - 31 * 86400000).toISOString() })), health, now).status).toBe('unknown');
  });
  it('does not reuse a selected-database artifact after selections change', () => {
    const selected = { ...job, databaseScope: 'selected', databases: ['new'] };
    expect(estimateNextBackup(selected, 'target', runs.map((run: any) => ({ ...run, databaseScope: 'selected', databases: ['old'] })), health, now).status).toBe('unknown');
  });
});
