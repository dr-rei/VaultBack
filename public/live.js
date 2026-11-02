(function (root) {
  function snapshotFingerprint(value) {
    try { return JSON.stringify(value); } catch { return ''; }
  }

  function createLiveRefreshCoordinator() {
    const running = new Map();
    const pending = new Map();
    return {
      schedule(key, run, isRelevant = () => true) {
        if (running.has(key)) {
          pending.set(key, { run, isRelevant });
          return running.get(key);
        }
        const task = Promise.resolve().then(run).finally(() => {
          running.delete(key);
          const next = pending.get(key);
          pending.delete(key);
          if (next && next.isRelevant()) void this.schedule(key, next.run, next.isRelevant);
        });
        running.set(key, task);
        return task;
      },
      clear() {
        pending.clear();
      }
    };
  }

  function createLiveOrchestrator(dependencies) {
    const refreshes = createLiveRefreshCoordinator();
    let executionsFingerprint = null;
    let notificationFingerprint = null;

    function onExecutions(payload) {
      if (!payload || !Array.isArray(payload.items)) return false;
      const fingerprint = snapshotFingerprint(payload);
      if (fingerprint === executionsFingerprint) return false;
      executionsFingerprint = fingerprint;
      const view = dependencies.getView();
      if (view === 'runs') {
        const query = dependencies.getHistoryQuery();
        if (query.page === 1 && !query.status) dependencies.applyExecutionSnapshot(payload);
        else refreshes.schedule('history', dependencies.refreshHistory, () => dependencies.getView() === 'runs');
        if (dependencies.hasSelectedExecution()) refreshes.schedule('execution-detail', dependencies.refreshDetail, () => dependencies.getView() === 'runs' && dependencies.hasSelectedExecution());
      } else if (view === 'dashboard') {
        refreshes.schedule('active-executions', dependencies.refreshActive, () => dependencies.getView() === 'dashboard');
      }
      return true;
    }

    function onNotificationDeliveries(payload) {
      if (dependencies.getRole() !== 'admin' || !payload || !Array.isArray(payload.items)) return false;
      const fingerprint = snapshotFingerprint(payload);
      if (fingerprint === notificationFingerprint) return false;
      notificationFingerprint = fingerprint;
      dependencies.storeNotificationDeliveries(payload);
      if (dependencies.getView() === 'settings' && dependencies.getSettingsSection() === 'notifications') dependencies.renderNotificationDeliveries(payload);
      return true;
    }

    return {
      onConnected() {
        executionsFingerprint = null;
        notificationFingerprint = null;
      },
      onExecutions,
      onNotificationDeliveries,
      clearPendingRefreshes: () => refreshes.clear()
    };
  }

  const api = { snapshotFingerprint, createLiveRefreshCoordinator, createLiveOrchestrator };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VaultBackLive = api;
})(typeof window === 'undefined' ? globalThis : window);
