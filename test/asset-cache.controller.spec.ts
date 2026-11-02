import { UnauthorizedException } from '@nestjs/common';
import { AssetCacheController } from '../src/system/asset-cache.controller';

describe('AssetCacheController', () => {
  const request: any = { method: 'GET', headers: { host: 'vaultback.example.com' } };
  let auth: any;
  let cache: any;
  let system: any;
  let controller: AssetCacheController;

  beforeEach(() => {
    auth = { requireAdmin: jest.fn().mockReturnValue({ user_id: 'admin-1' }) };
    cache = {
      settings: jest.fn().mockReturnValue({ config: { enabled: true }, rules: [] }),
      saveConfig: jest.fn().mockReturnValue({ enabled: false })
    };
    system = { audit: jest.fn() };
    controller = new AssetCacheController(cache, auth, system);
  });

  it('requires an administrator session to read the cache policy', () => {
    expect(controller.read(request)).toEqual({ config: { enabled: true }, rules: [] });
    expect(auth.requireAdmin).toHaveBeenCalledWith(request);
    expect(cache.settings).toHaveBeenCalledWith('vaultback.example.com', expect.stringContaining('public'));
  });

  it('routes writes through administrator authorization and records a non-secret audit event', () => {
    const body = { enabled: false, browserMaxAgeSeconds: 3600, edgeMaxAgeSeconds: 7200 };
    const response = controller.save({ ...request, method: 'POST' }, body as any);
    expect(auth.requireAdmin).toHaveBeenCalledWith({ ...request, method: 'POST' });
    expect(cache.saveConfig).toHaveBeenCalledWith(body);
    expect(system.audit).toHaveBeenCalledWith('admin-1', 'settings.cache.update', undefined, undefined, body);
    expect(response).toEqual({ config: { enabled: true }, rules: [] });
  });

  it('does not save when the administrator guard rejects the request, including CSRF failure', () => {
    auth.requireAdmin.mockImplementation(() => { throw new UnauthorizedException('CSRF validation failed'); });
    expect(() => controller.save({ ...request, method: 'POST' }, { enabled: false } as any)).toThrow('CSRF validation failed');
    expect(cache.saveConfig).not.toHaveBeenCalled();
    expect(system.audit).not.toHaveBeenCalled();
  });
});
