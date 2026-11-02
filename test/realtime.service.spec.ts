import { EventEmitter } from 'node:events';
import { RealtimeService } from '../src/system/realtime.service';
import { BackupService } from '../src/backup/backup.service';

describe('RealtimeService', () => {
  let service: RealtimeService;

  beforeEach(() => {
    service = new RealtimeService();
  });

  afterEach(() => {
    service.onApplicationShutdown();
    jest.useRealTimers();
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

  function response() {
    return Object.assign(new EventEmitter(), {write:jest.fn(),writeHead:jest.fn(),end:jest.fn(),writableEnded:false,destroyed:false});
  }
  function timedService() {
    service.onApplicationShutdown();
    jest.useFakeTimers();
    service = new RealtimeService();
  }
  function events(target: ReturnType<typeof response>, topic: string) {
    return target.write.mock.calls.filter(([text]) => String(text).startsWith(`event: ${topic}\n`));
  }
  it('refreshes idle process evidence past the 30-second freshness window', () => {
    timedService();
    const target = response();
    service.registerSnapshotProvider('processes', () => ({items:[],updatedAt:'unchanged-fixture-time'}));
    service.connect(target as any,'u','viewer','ip','token',['processes']);
    expect(events(target,'processes')).toHaveLength(1);
    jest.advanceTimersByTime(32000);
    expect(events(target,'processes')).toHaveLength(17);
    expect(service.connectionCount()).toBe(1);
  });
  it('registers the actual backup process snapshot during application bootstrap', () => {
    const realtime = {registerSnapshotProvider:jest.fn()};
    const backups = new BackupService({now:()=> 'fixture-now'} as any,{} as any,{} as any,realtime as any);
    backups.onApplicationBootstrap();
    expect(realtime.registerSnapshotProvider).toHaveBeenCalledWith('processes',expect.any(Function));
    expect(realtime.registerSnapshotProvider.mock.calls[0][1]()).toEqual({items:[],updatedAt:'fixture-now'});
  });
  it('suppresses unchanged snapshots and immediately sends current evidence to reconnects', () => {
    timedService();
    let payload = {items:[{id:'execution',status:'queued'}]};
    service.registerSnapshotProvider('executions', () => payload);
    const first = response();
    service.connect(first as any,'u','viewer','ip','token',['executions']);
    jest.advanceTimersByTime(10000);
    expect(events(first,'executions')).toHaveLength(1);
    payload = {items:[{id:'execution',status:'running'}]};
    jest.advanceTimersByTime(2000);
    expect(events(first,'executions')).toHaveLength(2);
    const second = response();
    service.connect(second as any,'u','viewer','ip','token',['executions']);
    expect(events(second,'executions')).toHaveLength(1);
    jest.advanceTimersByTime(2000);
    expect(events(first,'executions')).toHaveLength(2);
    expect(events(second,'executions')).toHaveLength(1);
  });
  it('uses a direct full event as the next snapshot baseline instead of duplicating it', () => {
    timedService();
    const payload = {items:[{id:'execution',status:'running'}]};
    service.registerSnapshotProvider('executions', () => payload);
    const target = response();
    service.connect(target as any,'u','viewer','ip','token',['executions']);
    service.publish('executions',payload);
    jest.advanceTimersByTime(2000);
    expect(events(target,'executions')).toHaveLength(2);
  });
  it('deduplicates only within each connection and revalidates snapshot sessions', () => {
    timedService();
    let active = true;
    service.setSessionValidator(token => active ? {user_id:token,role:'admin'} : undefined);
    const provider = jest.fn(context => ({items:[context.userId]}));
    service.registerSnapshotProvider('notification_deliveries',provider);
    const first=response(), second=response();
    service.connect(first as any,'a','admin','ip','a',['notification_deliveries']);
    service.connect(second as any,'b','admin','ip','b',['notification_deliveries']);
    expect(events(first,'notification_deliveries')[0][0]).toContain('"a"');
    expect(events(second,'notification_deliveries')[0][0]).toContain('"b"');
    provider.mockClear(); active=false;
    jest.advanceTimersByTime(2000);
    expect(provider).not.toHaveBeenCalled();
    expect(first.end).toHaveBeenCalled(); expect(second.end).toHaveBeenCalled();
    expect(service.connectionCount()).toBe(0);
  });
  it('does not invoke privileged providers after demotion and closes revoked heartbeat-only streams', () => {
    timedService();
    let session: any = {user_id:'u',role:'admin'};
    service.setSessionValidator(()=>session);
    const provider=jest.fn(()=>({items:[]}));
    service.registerSnapshotProvider('notification_deliveries',provider);
    const target=response();
    service.connect(target as any,'u','admin','ip','token',['notification_deliveries']);
    provider.mockClear();session={user_id:'u',role:'viewer'};
    jest.advanceTimersByTime(2000);
    expect(provider).not.toHaveBeenCalled();
    session=null;jest.advanceTimersByTime(25000);
    expect(target.end).toHaveBeenCalled();
  });

});
