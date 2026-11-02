import { BackupService } from '../src/backup/backup.service';
import { ExecutionController } from '../src/backup/execution.controller';
import { UnauthorizedException } from '@nestjs/common';

describe('execution HTTP authorization and admission', () => {
  const req = {method:'POST',headers:{}} as any;
  function setup() {
    const executions = {enqueue:jest.fn().mockReturnValue({id:'e',status:'queued'}),retry:jest.fn(),retryHistoricalRun:jest.fn().mockReturnValue({id:'retry-execution',status:'queued'}),cancel:jest.fn(),moveAhead:jest.fn(),list:jest.fn(),get:jest.fn().mockReturnValue({id:'e'}),audit:jest.fn()};
    const auth = {requireAdmin:jest.fn().mockReturnValue({user_id:'admin',role:'admin'}),requireSession:jest.fn().mockReturnValue({user_id:'viewer',role:'viewer'})};
    const realtime = {registerSnapshotProvider:jest.fn()};
    const controller = new ExecutionController(executions as any,{} as any,auth as any,realtime as any,{list:jest.fn()} as any);
    return {controller,executions,auth,realtime};
  }
  it('returns a queued acknowledgement with the authenticated actor', () => {
    const {controller,executions,auth} = setup();
    expect(controller.enqueue(req,'j')).toEqual({id:'e',status:'queued'});
    expect(auth.requireAdmin).toHaveBeenCalledWith(req);
    expect(executions.enqueue).toHaveBeenCalledWith('j','manual',{userId:'admin'});
  });
  it('does not admit work when session or CSRF validation rejects the request', () => {
    const {controller,executions,auth} = setup();
    auth.requireAdmin.mockImplementation(() => {throw new UnauthorizedException('CSRF validation failed');});
    expect(() => controller.enqueue(req,'j')).toThrow('CSRF validation failed');
    expect(executions.enqueue).not.toHaveBeenCalled();
  });
  it('queues a historical pair retry through administrator and CSRF validation', () => {
    const {controller,executions,auth} = setup();
    expect(controller.retryHistorical(req,'run')).toEqual({id:'retry-execution',status:'queued'});
    expect(executions.retryHistoricalRun).toHaveBeenCalledWith('run',{userId:'admin'});
    auth.requireAdmin.mockImplementation(() => {throw new UnauthorizedException('CSRF validation failed');});
    expect(() => controller.retryHistorical(req,'other')).toThrow('CSRF validation failed');
    expect(executions.retryHistoricalRun).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed retry selections and stop confirmations', () => {
    const {controller,executions} = setup();
    expect(() => controller.retry(req,'e',{pairs:[null]} as any)).toThrow();
    expect(() => controller.cancel(req,'e',{stopRunningConfirmed:'true'} as any)).toThrow();
    expect(executions.retry).not.toHaveBeenCalled(); expect(executions.cancel).not.toHaveBeenCalled();
  });
  it('passes pagination validation errors through the authenticated list route', () => {
    const {controller,executions,auth} = setup();
    executions.list.mockImplementation(() => {throw new Error('Invalid execution pagination');});
    const request = {query:{page:'Infinity'}} as any;
    expect(() => controller.list(request)).toThrow('Invalid execution pagination');
    expect(auth.requireSession).toHaveBeenCalledWith(request);
    expect(executions.list).toHaveBeenCalledWith(request.query);
  });
  it('publishes the same first-page shape the History view expects', () => {
    const {executions,realtime} = setup();
    const provider = realtime.registerSnapshotProvider.mock.calls.find(([topic]) => topic === 'executions')?.[1];
    expect(provider).toBeDefined();
    provider();
    expect(executions.list).toHaveBeenCalledWith({page:1,pageSize:15});
  });
  it('retries only the explicit selection using the authenticated actor', () => {
    const {controller,executions} = setup();
    const pairs = [{connectionId:'c1',storageTargetId:'s1'}];
    controller.retry(req,'cancelled-execution',{pairs});
    expect(executions.retry).toHaveBeenCalledWith('cancelled-execution',pairs,{userId:'admin'});
  });
  it('withholds administrator audit details from shared reads', () => {
    const {controller,executions,auth} = setup();
    expect(controller.get(req,'e')).toEqual({id:'e'});
    expect(auth.requireSession).toHaveBeenCalledWith(req); expect(executions.audit).not.toHaveBeenCalled();
  });
  it('keeps legacy responses pending until coordinated completion and returns artifact metadata', async () => {
    const backup = Object.create(BackupService.prototype) as any;
    let finish: any;
    backup.coordinator = {enqueue:jest.fn().mockReturnValue({id:'e',status:'queued'}),pump:jest.fn(),waitForTerminal:jest.fn().mockReturnValue(new Promise(resolve => {finish=resolve;}))};
    backup.store = {db:{prepare:jest.fn().mockReturnValue({get:jest.fn().mockReturnValue({id:'r',filename:'dump.sql',size_bytes:42,sha256:'hash',verification_status:'passed',verification_message:'verified'})})}};
    let settled = false;
    const pending = backup.runNow('j',{userId:'admin'}).then((value: any) => {settled=true; return value;});
    await Promise.resolve(); expect(settled).toBe(false);
    finish({jobId:'j',status:'success',pairs:[{connectionId:'c',storageTargetId:'s',status:'success',attempts:[{runId:'r'}]}]});
    await expect(pending).resolves.toMatchObject({ok:true,id:'r',filename:'dump.sql',sizeBytes:42,sha256:'hash',verification:{status:'passed',message:'verified'},executionId:'e'});
  });

});
