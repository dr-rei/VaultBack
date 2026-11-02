import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\r\n/g, '\n');

function runFunction(start: string, end: string, bindings: Record<string, unknown>) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  if (first < 0 || last < 0) throw new Error(`Could not locate ${start}`);
  const context = vm.createContext(bindings);
  vm.runInContext(source.slice(first, last), context);
  return (code: string) => vm.runInContext(code, context);
}

describe('application navigation regressions', () => {
  it('renders the existing Sessions screen without calling a missing renderer', () => {
    const fields = new Map<string, any>();
    const renderSessionsWithUsage = jest.fn();
    const run = runFunction('function setView(view, options = {}) {', '\n\nwindow.addEventListener(\'popstate\'', {
      state: { csrf: '', role: 'admin', currentView: 'dashboard' },
      document: { title: '', querySelectorAll: () => [], querySelector: () => null },
      window: { location: { pathname: '/history' }, history: { pushState: jest.fn(), replaceState: jest.fn() } },
      $: (selector: string) => { if (!fields.has(selector)) fields.set(selector, { textContent: '' }); return fields.get(selector); },
      vaultbackViewPaths: { sessions: '/sessions' },
      renderSessionsWithUsage,
      syncLiveProcessPolling: jest.fn(),
      syncSessionsRefreshPolling: jest.fn()
    });
    run("setView('sessions', {history:false})");
    expect(renderSessionsWithUsage).toHaveBeenCalledTimes(1);
  });

  it('exposes the sidebar on desktop after closing it at a responsive breakpoint', () => {
    let mobile = false;
    const sidebar = { setAttribute: jest.fn(), removeAttribute: jest.fn() };
    const shell = { classList: { toggle: jest.fn() } };
    const backdrop = { classList: { toggle: jest.fn() }, setAttribute: jest.fn() };
    const body = { classList: { toggle: jest.fn() } };
    const run = runFunction('function setMobileSidebarOpen(open, restoreFocus = false) {', '\n\nfunction initializeSidebar()', {
      document: { getElementById: (id: string) => id === 'app-shell' ? shell : id === 'primary-navigation' ? sidebar : id === 'sidebar-backdrop' ? backdrop : null, body },
      isMobileSidebarViewport: () => mobile,
      updateSidebarControls: jest.fn(),
      requestAnimationFrame: jest.fn()
    });
    run('setMobileSidebarOpen(false)');
    expect(sidebar.setAttribute).toHaveBeenCalledWith('aria-hidden', 'false');
    mobile = true;
    run('setMobileSidebarOpen(false)');
    expect(sidebar.setAttribute).toHaveBeenLastCalledWith('aria-hidden', 'true');
  });

  it('shows audit load failures as unavailable and leaves the group retryable', async () => {
    const elements = new Map<string, any>();
    for (const selector of ['#audit-list', '#audit-count-badge', '#audit-total', '#audit-visible', '#audit-pagination']) {
      elements.set(selector, { innerHTML: '', textContent: '', replaceChildren: jest.fn() });
    }
    const run = runFunction('async function loadAudit() {', '\nasync function reconcileBackupArtifacts()', {
      state: { audit: { items: [], total: 0, page: 1, pageSize: 25, pageCount: 1 } },
      api: jest.fn().mockRejectedValue(new Error('Audit service unavailable')),
      $: (selector: string) => elements.get(selector) || null,
      document: { createTextNode: (value: string) => value },
      auditEventMarkup: jest.fn(),
      esc: (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    });
    await run('loadAudit()');
    expect(run('auditLoaded')).toBe(false);
    expect(elements.get('#audit-count-badge').textContent).toBe('Unavailable');
    expect(elements.get('#audit-list').innerHTML).toContain('Audit service unavailable');
    expect(elements.get('#audit-list').innerHTML).toContain('role="alert"');
  });
});
