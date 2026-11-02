const { createLiveOrchestrator, createLiveRefreshCoordinator } = require('../public/live.js') as {
  createLiveOrchestrator: (dependencies: Record<string, any>) => any;
  createLiveRefreshCoordinator: () => { schedule: (key: string, run: () => unknown, isRelevant?: () => boolean) => Promise<unknown> };
};

describe('live observation coordinator', () => {
  it('uses the default execution snapshot in History and suppresses identical payloads', () => {
    const applyExecutionSnapshot = jest.fn();
    const refreshHistory = jest.fn();
    const orchestrator = createLiveOrchestrator({
      getView: () => 'runs', getRole: () => 'admin', getSettingsSection: () => 'general',
      getHistoryQuery: () => ({ page: 1, status: '' }), hasSelectedExecution: () => false,
      applyExecutionSnapshot, refreshHistory, refreshActive: jest.fn(), refreshDetail: jest.fn(),
      storeNotificationDeliveries: jest.fn(), renderNotificationDeliveries: jest.fn()
    });
    const payload = { items: [{ id: 'run-1' }], total: 1, page: 1, pageSize: 15, pageCount: 1 };
    expect(orchestrator.onExecutions(payload)).toBe(true);
    expect(orchestrator.onExecutions(payload)).toBe(false);
    expect(applyExecutionSnapshot).toHaveBeenCalledTimes(1);
    expect(refreshHistory).not.toHaveBeenCalled();
    orchestrator.onConnected();
    expect(orchestrator.onExecutions(payload)).toBe(true);
  });

  it('refreshes filtered History and the active queue only while each view is visible', async () => {
    let view = 'runs';
    const refreshHistory = jest.fn();
    const refreshActive = jest.fn();
    const orchestrator = createLiveOrchestrator({
      getView: () => view, getRole: () => 'admin', getSettingsSection: () => 'general',
      getHistoryQuery: () => ({ page: 2, status: 'failed' }), hasSelectedExecution: () => false,
      applyExecutionSnapshot: jest.fn(), refreshHistory, refreshActive, refreshDetail: jest.fn(),
      storeNotificationDeliveries: jest.fn(), renderNotificationDeliveries: jest.fn()
    });
    orchestrator.onExecutions({ items: [{ id: 'one' }] });
    await Promise.resolve();
    expect(refreshHistory).toHaveBeenCalledTimes(1);
    view = 'settings';
    orchestrator.onExecutions({ items: [{ id: 'two' }] });
    await Promise.resolve();
    expect(refreshHistory).toHaveBeenCalledTimes(1);
    view = 'dashboard';
    orchestrator.onExecutions({ items: [{ id: 'three' }] });
    await Promise.resolve();
    expect(refreshActive).toHaveBeenCalledTimes(1);
  });

  it('stores admin delivery snapshots while hidden and renders them only in Notifications', () => {
    let section = 'general';
    const storeNotificationDeliveries = jest.fn();
    const renderNotificationDeliveries = jest.fn();
    const orchestrator = createLiveOrchestrator({
      getView: () => 'settings', getRole: () => 'admin', getSettingsSection: () => section,
      getHistoryQuery: () => ({ page: 1, status: '' }), hasSelectedExecution: () => false,
      applyExecutionSnapshot: jest.fn(), refreshHistory: jest.fn(), refreshActive: jest.fn(), refreshDetail: jest.fn(),
      storeNotificationDeliveries, renderNotificationDeliveries
    });
    const payload = { items: [{ id: 'delivery-1' }], lastPollError: '' };
    expect(orchestrator.onNotificationDeliveries(payload)).toBe(true);
    expect(storeNotificationDeliveries).toHaveBeenCalledWith(payload);
    expect(renderNotificationDeliveries).not.toHaveBeenCalled();
    section = 'notifications';
    expect(orchestrator.onNotificationDeliveries({ items: [{ id: 'delivery-2' }] })).toBe(true);
    expect(renderNotificationDeliveries).toHaveBeenCalledTimes(1);
  });

  it('coalesces multiple refresh events into one trailing request and drops stale work', async () => {
    const coordinator = createLiveRefreshCoordinator();
    let releaseFirst!: () => void;
    let relevant = true;
    const run = jest.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { releaseFirst = resolve; }))
      .mockResolvedValue(undefined);
    const first = coordinator.schedule('history', run, () => relevant);
    await Promise.resolve();
    coordinator.schedule('history', run, () => relevant);
    coordinator.schedule('history', run, () => relevant);
    expect(run).toHaveBeenCalledTimes(1);
    releaseFirst();
    await first;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(2);

    let releaseSecond!: () => void;
    const secondCoordinator = createLiveRefreshCoordinator();
    const second = secondCoordinator.schedule('detail', () => new Promise<void>(resolve => { releaseSecond = resolve; }), () => relevant);
    await Promise.resolve();
    secondCoordinator.schedule('detail', () => run(), () => relevant);
    relevant = false;
    releaseSecond();
    await second;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(2);
  });
});
