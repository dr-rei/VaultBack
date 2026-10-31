import { EventEmitter } from 'node:events';
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
  it('closes revoked streams before delivery and prunes topics after demotion', () => {
    const response = Object.assign(new EventEmitter(), {write:jest.fn(),writeHead:jest.fn(),end:jest.fn(),writableEnded:false,destroyed:false});
    let session: any = {user_id:'u',role:'admin'};
    service.setSessionValidator(() => session);
    service.connect(response as any,'u','admin','ip','token',['executions','notification_deliveries']);
    response.write.mockClear(); session = {user_id:'u',role:'viewer'};
    service.publish('notification_deliveries',{secret:true});
    expect(response.write).not.toHaveBeenCalled();
    session = null;
    service.publish('executions',{items:[]});
    expect(response.end).toHaveBeenCalled();
    expect(service.connectionCount()).toBe(0);
  });

});
