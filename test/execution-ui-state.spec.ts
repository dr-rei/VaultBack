import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const root = { innerHTML: '', classList: { add: jest.fn(), remove: jest.fn() }, focus: jest.fn(), setAttribute: jest.fn(), removeAttribute: jest.fn(), querySelectorAll: () => [], contains: () => false };
  const api = jest.fn();
  const dialog = jest.fn();
  const context = vm.createContext({ URLSearchParams, api, appDialog: dialog, document: { getElementById: () => root, querySelectorAll: () => [], activeElement: null }, state: { role: 'admin', pageData: { runs: [] } }, esc: String, toast: jest.fn(), setView: jest.fn() });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/operations.js'), 'utf8'), context);
  vm.runInContext('renderExecutionDetail = () => {}; renderExecutions = () => {};', context);
  return { root, api, dialog, run: (code: string) => vm.runInContext(code, context) };
}

describe('execution UI request ownership', () => {
  it('uses the asynchronous historical retry endpoint and inspects the execution ID', async () => {
    const f = fixture();
    const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    f.run(source.slice(source.indexOf('async function retryRun('), source.indexOf('async function showVerificationReport(')));
    f.run('loadExecutions=async()=>{};inspectExecution=async(id)=>{executionUi.selectedId=id};');
    f.dialog.mockResolvedValue(true); f.api.mockResolvedValue({ id: 'execution-child' });
    await f.run("retryRun('artifact-id')");
    expect(f.api.mock.calls[0][0]).toBe('/api/runs/artifact-id/retry-execution');
    expect(f.run('executionUi.selectedId')).toBe('execution-child');
  });
  it('requires fresh confirmation before retrying successful pairs', async () => {
    const f = fixture();
    f.run("executionUi.selectedId='a';executionUi.detail={id:'a',pairs:[{id:'p',status:'success',connectionId:'c',storageTargetId:'s'}]};");
    f.dialog.mockResolvedValue(false); await f.run("executionAction('retry-all','a')");
    expect(f.dialog).toHaveBeenCalled(); expect(f.api).not.toHaveBeenCalled();
  });
  it('keeps last known queue evidence on failure and ignores obsolete refreshes', async () => {
    const f = fixture(), stale = deferred();
    f.run("renderOverviewOperations=()=>{};executionUi.active=[{id:'known'}]");
    f.api.mockReturnValueOnce(stale.promise).mockResolvedValueOnce({items:[]}).mockResolvedValueOnce({items:[]}).mockResolvedValueOnce({items:[]});
    const old=f.run('loadActiveExecutions()');
    f.api.mockResolvedValue({items:[{id:'current'}]}); await f.run('loadActiveExecutions()');
    stale.reject(new Error('obsolete')); await old;
    expect(f.run('executionUi.active[0].id')).toBe('current');
    expect(f.run('executionUi.activeError')).toBe('');
    f.api.mockRejectedValue(new Error('offline')); await f.run('loadActiveExecutions()');
    expect(f.run('executionUi.active[0].id')).toBe('current');
    expect(f.run('executionUi.activeError')).toBe('offline');
  });
  it('keeps the newly inspected execution when an older request resolves last', async () => {
    const f = fixture(), first = deferred(), second = deferred();
    f.api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = f.run("inspectExecution('a')"), b = f.run("inspectExecution('b')");
    expect(f.run('executionUi.detail')).toBeNull();
    second.resolve({ id: 'b' }); await b;
    first.resolve({ id: 'a' }); await a;
    expect(f.run('executionUi.detail.id')).toBe('b');
  });
  it('does not reopen or populate detail after close, including a failed request', async () => {
    const f = fixture(), request = deferred(); f.api.mockReturnValue(request.promise);
    const pending = f.run("inspectExecution('a')"); f.run('closeExecutionDetail()');
    const markup = f.root.innerHTML; request.reject(new Error('late error')); await pending;
    expect(f.run('executionUi.detail')).toBeNull();
    expect(f.root.innerHTML).toBe(markup);
    expect(f.root.classList.remove).toHaveBeenCalledTimes(1);
  });
  it('discards a refresh started before another execution was inspected', async () => {
    const f = fixture(), refresh = deferred(), inspect = deferred();
    f.run("executionUi.selectedId='a'; executionUi.detail={id:'a'}");
    f.api.mockReturnValueOnce(refresh.promise).mockReturnValueOnce(inspect.promise);
    const old = f.run('refreshExecutionDetail()'), current = f.run("inspectExecution('b')");
    inspect.resolve({ id: 'b' }); await current; refresh.resolve({ id: 'a' }); await old;
    expect(f.run('executionUi.detail.id')).toBe('b');
  });
  it('ignores refresh success after closing its detail', async () => {
    const f = fixture(), refresh = deferred();
    f.run("executionUi.selectedId='a';executionUi.detail={id:'a'}");
    f.api.mockReturnValue(refresh.promise);
    const pending = f.run('refreshExecutionDetail()'); f.run('closeExecutionDetail()');
    refresh.resolve({ id: 'a' }); await pending;
    expect(f.run('executionUi.detail')).toBeNull();
    expect(f.run('executionUi.selectedId')).toBeNull();
  });
  it('clears rows on a new filter and rejects stale list responses', async () => {
    const f = fixture(), first = deferred(), second = deferred();
    f.api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = f.run('loadExecutions()');
    f.run("executionUi.status='failed'; executionUi.items=[{id:'old'}]");
    const b = f.run('loadExecutions()');
    expect(f.run('executionUi.items.length')).toBe(0);
    second.resolve({ items: [{ id: 'failed' }], pageCount: 1 }); await b;
    first.resolve({ items: [{ id: 'stale' }], pageCount: 9 }); await a;
    expect(f.run('executionUi.items[0].id')).toBe('failed');
    expect(f.run('executionUi.pageCount')).toBe(1);
  });
  it('does not reopen a detail closed while a cancellation was being submitted', async () => {
    const f = fixture(), mutation = deferred();
    f.run("executionUi.selectedId='a';executionUi.detail={id:'a',pairs:[]};loadExecutions=async()=>{};");
    f.api.mockReturnValue(mutation.promise);
    const pending = f.run("executionAction('cancel','a')"); f.run('closeExecutionDetail()');
    mutation.resolve({ id: 'a' }); await pending;
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(f.run('executionUi.selectedId')).toBeNull();
  });
  it('includes never-started pairs when retrying a cancelled queue', async () => {
    const f = fixture();
    f.run("executionUi.selectedId='a';executionUi.detail={id:'a',pairs:[{id:'p',status:'not_started',connectionId:'c',storageTargetId:'s'}]};loadExecutions=async()=>{};inspectExecution=async()=>{};");
    f.api.mockResolvedValue({ id: 'retry' }); await f.run("executionAction('retry-failed','a')");
    expect(JSON.parse(f.api.mock.calls[0][1].body)).toEqual({ pairs: [{ connectionId: 'c', storageTargetId: 's' }] });
  });
});
