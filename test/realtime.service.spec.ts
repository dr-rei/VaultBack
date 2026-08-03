import { RealtimeService } from '../src/system/realtime.service';

describe('RealtimeService', () => {
  let service: RealtimeService;

  beforeEach(() => {
    service = new RealtimeService();
  });

  afterEach(() => {
    service.onApplicationShutdown();
  });

  it('limits privileged topics to administrators', () => {
    expect(service.allowedTopics('admin')).toContain('sessions');
    expect(service.allowedTopics('admin')).toContain('rate_limit');
    expect(service.allowedTopics('operator')).not.toContain('sessions');
    expect(service.allowedTopics('viewer')).not.toContain('updates');
  });
});
