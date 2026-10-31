import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function deferred() { let resolve!: (value: any) => void; const promise=new Promise<any>(yes=>{resolve=yes;}); return {promise,resolve}; }
function fixture() {
  const elements=new Map<string,any>();
  const element=(id:string)=>{id=id.replace(/^#/, '');if(!elements.has(id))elements.set(id,{innerHTML:'',value:'recovery',checked:true,disabled:false,isConnected:true,classList:{add:jest.fn(),remove:jest.fn(),toggle:jest.fn()},insertAdjacentHTML:jest.fn(),querySelector:()=>({focus:jest.fn()}),querySelectorAll:()=>[],contains:()=>false,focus:jest.fn(),getClientRects:()=>[{}],remove:jest.fn()});return elements.get(id);};
  const api=jest.fn(),dialog=jest.fn(),timer=jest.fn();
  const context=vm.createContext({api,appDialog:dialog,esc:String,fmtDate:String,toast:jest.fn(),setTimeout:timer,clearTimeout:jest.fn(),setView:jest.fn(),openRecoveryConnectionModal:jest.fn(),document:{body:element('body')},$:element,state:{role:'admin',pageData:{runs:[{id:'artifact',filename:'fixture.sql',databaseScope:'selected',databases:['fixture'],databaseConnectionId:'source'}]},connections:[{id:'source',name:'Production',host:'source',port:3306,engine:'mariadb'}],recoveryConnections:[]}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/operations.js'),'utf8'),context);
  const app=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  vm.runInContext(app.slice(app.indexOf('function closeRestoreModal('),app.indexOf('function renderRuns()')),context);
  return {api,dialog,timer,element,run:(code:string)=>vm.runInContext(code,context)};
}
describe('guided artifact recovery UI',()=>{
  it('closes with Escape and returns focus to the opener',async()=>{
    const f=fixture();f.api.mockResolvedValue([]);f.run("document.activeElement=$('opener')");
    await f.run("openRestoreModal('artifact')");
    const preventDefault=jest.fn(),stopPropagation=jest.fn();
    f.element('restore-modal').onkeydown({key:'Escape',preventDefault,stopPropagation});
    expect(preventDefault).toHaveBeenCalled();expect(stopPropagation).toHaveBeenCalled();
    expect(f.element('restore-modal').remove).toHaveBeenCalled();expect(f.element('opener').focus).toHaveBeenCalled();
  });
  it('traps forward and reverse Tab within the advanced restore dialog',()=>{
    const f=fixture();f.run("openAdvancedRestoreModal('artifact')");
    const first=f.element('first'),last=f.element('last'),modal=f.element('restore-modal');
    modal.querySelectorAll=()=>[first,last];modal.contains=()=>true;
    f.run("document.activeElement=$('last')");const forward=jest.fn();modal.onkeydown({key:'Tab',shiftKey:false,preventDefault:forward});
    expect(forward).toHaveBeenCalled();expect(first.focus).toHaveBeenCalled();
    f.run("document.activeElement=$('first')");const backward=jest.fn();modal.onkeydown({key:'Tab',shiftKey:true,preventDefault:backward});
    expect(backward).toHaveBeenCalled();expect(last.focus).toHaveBeenCalled();
  });
  it('defaults to dedicated rehearsal and offers recovery configuration when absent',async()=>{
    const f=fixture();f.api.mockResolvedValue([]);await f.run("openRestoreModal('artifact')");
    expect(f.api).toHaveBeenCalledWith('/api/recovery/connections');
    expect(f.element('artifact-rehearsal-controls').innerHTML).toContain('Configure recovery server');
    expect(f.api.mock.calls.some(call=>call[0].endsWith('/restore'))).toBe(false);
  });
  it('starts only a rehearsal, then renders verification and cleanup evidence',async()=>{
    const f=fixture();f.run("guidedRestoreUi.generation=3");
    f.api.mockResolvedValueOnce({runId:'test'}).mockResolvedValueOnce({runId:'test',backupRunId:'artifact',recoveryConnectionId:'recovery',status:'warning',evidence:{verification:{tables:2},cleanupWarnings:['scratch cleanup failed']}});
    await f.run("startArtifactRehearsal('artifact',3)");
    expect(f.api.mock.calls[0][0]).toBe('/api/recovery/rehearsals');
    expect(JSON.parse(f.api.mock.calls[0][1].body)).toEqual({backupRunId:'artifact',recoveryConnectionId:'recovery'});
    expect(f.element('artifact-rehearsal-evidence').innerHTML).toContain('scratch cleanup failed');
    expect(f.timer).not.toHaveBeenCalled();
  });
  it('does not reopen or keep polling after the user closes the dialog',async()=>{
    const f=fixture(),request=deferred();f.api.mockReturnValue(request.promise);
    const pending=f.run("pollArtifactRehearsal('test',0)");f.run('closeRestoreModal()');
    request.resolve({runId:'test',status:'running'});await pending;
    expect(f.element('artifact-rehearsal-evidence').innerHTML).toBe('');
    expect(f.timer).not.toHaveBeenCalled();
  });
  it('describes terminal evidence as completed rather than queued',()=>{
    const f=fixture();f.run("renderArtifactRehearsal({runId:'test',status:'passed',evidence:{}})");
    expect(f.element('artifact-rehearsal-evidence').innerHTML).toContain('Verification completed');
    expect(f.element('artifact-rehearsal-evidence').innerHTML).not.toContain('queued');
    f.run("renderArtifactRehearsal({runId:'test',status:'warning',evidence:{cleanupWarnings:['cleanup failed']}})");
    expect(f.element('artifact-rehearsal-evidence').innerHTML).toContain('Completed with warnings');
  });
  it('does not start monitoring a late accepted rehearsal after dismissal',async()=>{
    const f=fixture(),request=deferred();f.api.mockReturnValue(request.promise);
    const pending=f.run("startArtifactRehearsal('artifact',0)");f.run('closeRestoreModal()');
    request.resolve({runId:'test'});await pending;
    expect(f.api).toHaveBeenCalledTimes(1);expect(f.timer).not.toHaveBeenCalled();
  });
  it('never treats an old checked warning as production restore confirmation',async()=>{
    const f=fixture();f.run("openAdvancedRestoreModal('artifact')");
    f.element('restore-mode').value='overwrite';f.element('restore-database-name').value='';
    f.dialog.mockResolvedValue(false);await f.element('restore-submit').onclick();
    expect(f.dialog).toHaveBeenCalledWith(expect.objectContaining({title:'Confirm production restore',danger:true}));
    expect(f.api).not.toHaveBeenCalled();
  });
  it('does not submit production restore if its dialog was dismissed during confirmation',async()=>{
    const f=fixture(),confirmation=deferred();f.run("openAdvancedRestoreModal('artifact')");
    f.element('restore-mode').value='overwrite';f.element('restore-database-name').value='';
    f.dialog.mockReturnValue(confirmation.promise);const pending=f.element('restore-submit').onclick();f.run('closeRestoreModal()');confirmation.resolve(true);await pending;
    expect(f.api).not.toHaveBeenCalled();
  });
  it('submits only the explicitly confirmed production destination and mode',async()=>{
    const f=fixture();f.run("openAdvancedRestoreModal('artifact')");
    f.element('restore-mode').value='new';f.element('restore-database-name').value='recovered_copy';f.element('restore-connection').value='source';
    f.dialog.mockResolvedValue(true);f.api.mockResolvedValue({message:'Restored'});await f.element('restore-submit').onclick();
    expect(f.api.mock.calls[0][0]).toBe('/api/runs/artifact/restore');
    expect(JSON.parse(f.api.mock.calls[0][1].body)).toEqual({connectionId:'source',mode:'new',databaseName:'recovered_copy',overwriteConfirmed:true});
  });
});
