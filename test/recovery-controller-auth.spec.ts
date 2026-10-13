import { BackupController } from '../src/backup/backup.controller';
import { RecoveryController } from '../src/recovery/recovery.controller';

describe('backup and PITR write authorization', () => {
  it('requires an administrator to run or retry a backup', async () => {
    const auth = { requireAdmin: jest.fn(), requireSession: jest.fn() };
    const backups = { runNow: jest.fn().mockResolvedValue({ ok: true }), retryRun: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new BackupController(backups as any, auth as any, {} as any, {} as any);
    const request = { method: 'POST' } as any;

    await controller.run(request, 'job-id');
    controller.retry(request, 'run-id');

    expect(auth.requireAdmin).toHaveBeenNthCalledWith(1, request);
    expect(auth.requireAdmin).toHaveBeenNthCalledWith(2, request);
    expect(auth.requireSession).not.toHaveBeenCalled();
  });

  it('requires CSRF protection for download preparation', () => {
    const auth = { requireAdmin: jest.fn(), requireSession: jest.fn().mockReturnValue({ user_id: 'user-id' }) };
    const backups = { startDownloadPreparation: jest.fn().mockReturnValue({ ok: true }) };
    const controller = new BackupController(backups as any, auth as any, {} as any, {} as any);
    const request = { method: 'POST' } as any;

    controller.prepareDownload(request, 'run-id');

    expect(auth.requireSession).toHaveBeenCalledWith(request, true);
    expect(backups.startDownloadPreparation).toHaveBeenCalledWith('run-id', 'user-id');
  });

  it('restricts PITR configuration and rehearsal endpoints to admins', () => {
    const auth = { requireAdmin: jest.fn(), requireSession: jest.fn() };
    const recovery = { savePitrConfiguration: jest.fn(), startPitrRehearsal: jest.fn(), getPitrRehearsal: jest.fn() };
    const controller = new RecoveryController(auth as any, recovery as any);
    const request = { method: 'POST' } as any;

    controller.configurePitr(request, {} as any);
    controller.startPitrRehearsal(request, {} as any);
    controller.getPitrRehearsal(request, 'rehearsal-id');

    expect(auth.requireAdmin).toHaveBeenCalledTimes(3);
    expect(auth.requireAdmin).toHaveBeenCalledWith(request);
    expect(auth.requireSession).not.toHaveBeenCalled();
  });
});
