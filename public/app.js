const state = { csrf: '', userId: '', isPrimary: false, connections: [], storage: [], jobs: [], runs: [], processes: [], sessions: [], sessionInfo: null, currentView: 'dashboard', dependencies: null, toolDiagnostics: null, toolDiagnosticsLoadedAt: 0, encryption: null, role: 'viewer', capacity: [], setupStatus: null, notifications: null, users: [], list: { connections: { page: 1, pageSize: 25, search: '' }, storage: { page: 1, pageSize: 25, search: '' }, jobs: { page: 1, pageSize: 25, search: '' }, runs: { page: 1, pageSize: 25, search: '', status: '' }, users: { page: 1, pageSize: 25, search: '' }, sessions: { page: 1, pageSize: 25 } }, meta: {} };
let liveProcessTimer = null;
var vaultbackCollectionEndpoints = { connections: '/api/connections', storage: '/api/storage', jobs: '/api/jobs', runs: '/api/runs', users: '/api/auth/users' };
var vaultbackSearchTimers = {};
var vaultbackJobRunPages = {};
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest('#new-user, #cancel-user, #save-user') : null;
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (target.id === 'new-user') openUserModal();
  else if (target.id === 'cancel-user') closeUserModal();
  else void saveUser();
}, true);
const fmtDate = (v) => v ? new Date(v).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : '—';
const fmtBytes = (n) => !n ? '—' : n < 1024*1024 ? `${Math.round(n/1024)} KB` : `${(n/1024/1024).toFixed(1)} MB`;
function updateThemeButton() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const next = theme === 'dark' ? 'light' : 'dark';
  const toggle = $('#theme-toggle');
  if (!toggle) return;
  toggle.setAttribute('aria-pressed', String(theme === 'dark'));
  toggle.setAttribute('aria-label', `Switch to ${next} mode`);
  toggle.title = `Switch to ${next} mode`;
  const icon = $('#theme-icon');
  const label = $('#theme-label');
  if (icon) icon.textContent = theme === 'dark' ? '☀' : '☾';
  if (label) label.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
}
function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  document.cookie = `vb_theme=${next}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  updateThemeButton();
}
function toast(message, error=false){const el=$('#toast');el.textContent=message;el.style.zIndex='100';el.className=`toast show${error?' error':''}`;setTimeout(()=>el.className='toast',3500)}
function appDialog({title='Please confirm',message='',confirmText='Continue',cancelText='Cancel',danger=false,showCancel=true}={}){return new Promise(resolve=>{const root=$('#modal-root');if(!root)return resolve(false);const previous=document.activeElement;const id=`app-dialog-${Date.now()}`;root.insertAdjacentHTML('beforeend',`<section id="${id}" class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}-title"><div class="confirm-dialog-card"><div class="confirm-dialog-mark ${danger?'danger':''}">${danger?'!':'?'}</div><div class="confirm-dialog-copy"><h3 id="${id}-title">${esc(title)}</h3><p>${esc(message)}</p></div><div class="confirm-dialog-actions">${showCancel?`<button type="button" class="secondary" data-dialog-cancel>${esc(cancelText)}</button>`:''}<button type="button" class="${danger?'danger-button':'primary'}" data-dialog-confirm>${esc(confirmText)}</button></div></div></section>`);const modal=document.getElementById(id);let settled=false;const finish=value=>{if(settled)return;settled=true;modal?.remove();if(!document.querySelector('.form-panel:not(.hidden), .user-form:not(.hidden), .confirm-dialog'))document.body.classList.remove('modal-open');if(previous instanceof HTMLElement)previous.focus();resolve(value)};modal.querySelector('[data-dialog-confirm]').onclick=()=>finish(true);modal.querySelector('[data-dialog-cancel]')?.addEventListener('click',()=>finish(false));modal.addEventListener('click',event=>{if(event.target===modal)finish(false)});modal.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();finish(false)}});document.body.classList.add('modal-open');requestAnimationFrame(()=>modal.querySelector('[data-dialog-confirm]')?.focus())})}
function confirmAction(message,title='Confirm deletion'){return appDialog({title,message,confirmText:'Delete',danger:true})}
function dependencyNotice(){if(!state.dependencies||state.dependencies.ok)return '';const missing=state.dependencies.engines.map(item=>`${item.engine}: ${item.client.available?'client ready':'client missing'}, ${item.dump.available?'dump ready':'dump missing'}`).join(' · ');return `<div class="callout dependency-warning"><b>Bundled backup tools required</b><br>${esc(missing)}<br>Connection tests and database discovery are ready; use Settings → Database tools to install or repair the dump tools for backups and restores.</div>`}
function renderDependencyBanner(){const el=$('#dependency-banner');if(!el)return;el.innerHTML=dependencyNotice();if(state.dependencies&&!state.dependencies.ok&&state.role==='admin'){const action=document.createElement('button');action.type='button';action.className='secondary dependency-setup-button';action.textContent='Set up database tools';action.onclick=()=>void openDependencySetup();el.firstElementChild?.appendChild(action)}el.classList.toggle('hidden',!state.dependencies||state.dependencies.ok)}
function renderEncryptionBanner(){const el=$('#encryption-banner');if(!el)return;const issue=state.encryption?.status==='error';el.innerHTML=issue?`<div class="callout encryption-warning"><b>Encryption key problem</b><br>${esc(state.encryption.message)}<br><small>Restore the original key, then restart VaultBack. Do not delete the SQLite database.</small></div>`:'';el.classList.toggle('hidden',!issue)}
async function loadHealthDetails(){try{const health=await api('/api/health/details');state.dependencies=health.dependencies||null;state.encryption=health.encryption||null;state.capacity=health.capacity||[]}catch{state.dependencies=null;state.encryption=null;state.capacity=[]}renderDependencyBanner();renderEncryptionBanner()}
function closeDependencySetup(){const modal=$('#dependency-setup-modal');modal?.remove();if(!document.querySelector('.form-panel:not(.hidden), .user-form:not(.hidden), .confirm-dialog, .dependency-setup-modal'))document.body.classList.remove('modal-open')}
function dependencyInstallMarkup(job){const percent=Number.isFinite(Number(job?.percent))?Math.max(0,Math.min(100,Number(job.percent))):0;const complete=job?.state==='completed';const failed=job?.state==='failed';return `<div class="dependency-install-status ${complete?'is-complete':''} ${failed?'is-failed':''}"><div class="dependency-install-status-head"><b>${esc(job?.message||'Preparing tool setup…')}</b><span>${complete?'Ready':failed?'Failed':`${percent}%`}</span></div><div class="dependency-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>${job?.totalBytes?`<small>${esc(fmtBytes(job.bytesDownloaded))} of ${esc(fmtBytes(job.totalBytes))}</small>`:''}${failed?`<div class="callout dependency-warning">${esc(job.error||job.message||'Tool setup failed')}</div>`:''}</div>`}
function toolStatusLabel(status){return status==='working'?'Working fine':status==='missing'?'Missing':'Corrupt or not responding'}
function toolStatusDescription(item){const client=item.client?.status||'missing';const dump=item.dump?.status||'missing';return `Client: ${item.client?.command||'not found'} · ${toolStatusLabel(client)}; dump: ${item.dump?.command||'not found'} · ${toolStatusLabel(dump)}`}
function renderDependencyDiagnostics(data){
  const root=$('#dependency-tools-status');
  const repair=$('#repair-dependency-tools');
  if(!root)return;
  if(!data?.engines?.length){root.innerHTML='<div class="empty">Unable to check database tools.</div>';if(repair)repair.classList.add('hidden');return}
  root.innerHTML=`<div class="tool-status-list">${data.engines.map(item=>{const status=['working','missing','corrupt'].includes(item.status)?item.status:'corrupt';const label=item.engine==='mysql'?'MySQL':'MariaDB';return `<div class="tool-status-row"><div class="tool-status-copy"><b>${esc(label)} tools</b><small>${esc(toolStatusDescription(item))}</small></div><span class="tool-status-badge ${status}">${esc(toolStatusLabel(status))}</span></div>`}).join('')}</div>`;
  if(repair){repair.classList.toggle('hidden',state.role!=='admin'||!data.installer?.supported);repair.disabled=false}
}
async function loadDependencyDiagnostics(force=false){
  const root=$('#dependency-tools-status');
  if(!force&&state.toolDiagnostics&&Date.now()-state.toolDiagnosticsLoadedAt<30000){renderDependencyDiagnostics(state.toolDiagnostics);return}
  if(state.toolDiagnosticsLoading)return;
  state.toolDiagnosticsLoading=true;
  if(root)root.innerHTML='<div class="empty">Checking database tools…</div>';
  try{state.toolDiagnostics=await api('/api/dependencies/status');state.toolDiagnosticsLoadedAt=Date.now();renderDependencyDiagnostics(state.toolDiagnostics)}catch(e){if(root)root.innerHTML=`<div class="callout dependency-warning">${esc(e.message||'Unable to check database tools.')}</div>`}finally{state.toolDiagnosticsLoading=false}
}
async function repairDependencyTools(){
  if(state.role!=='admin')return toast('Only an administrator can repair database tools',true);
  const confirmed=await appDialog({title:'Repair database tools?',message:'VaultBack will remove its platform-specific portable tool directory, then download and verify a fresh official package inside this application directory. Operating-system installations and PATH entries are ignored.',confirmText:'Repair and redownload',cancelText:'Cancel',danger:true});
  if(!confirmed)return;
  const button=$('#repair-dependency-tools');
  if(button)button.disabled=true;
  const root=$('#dependency-tools-status');
  try{let job=await api('/api/dependencies/repair',{method:'POST',body:JSON.stringify({})});if(root)root.innerHTML=dependencyInstallMarkup(job);while(!['completed','failed'].includes(job.state)){await new Promise(resolve=>setTimeout(resolve,900));job=await api(`/api/dependencies/install/${encodeURIComponent(job.id)}`);if(root)root.innerHTML=dependencyInstallMarkup(job)}if(job.state==='completed'){state.toolDiagnostics=null;state.toolDiagnosticsLoadedAt=0;await loadHealthDetails();await loadDependencyDiagnostics(true);toast('Database tools repaired and ready')}else{await loadDependencyDiagnostics(true);toast(job.error||'Tool repair failed',true)}}catch(e){if(root)root.innerHTML=`<div class="callout dependency-warning">${esc(e.message||'Tool repair failed')}</div>`;toast(e.message||'Tool repair failed',true)}finally{if(button)button.disabled=false}
}
function bindDependencyToolsControls(){if(document.body.dataset.dependencyToolsBound)return;document.body.dataset.dependencyToolsBound='1';$('#refresh-dependency-tools')?.addEventListener('click',()=>void loadDependencyDiagnostics(true));$('#repair-dependency-tools')?.addEventListener('click',()=>void repairDependencyTools())}
async function openDependencySetup(){if(state.role!=='admin')return toast('Only an administrator can install database tools',true);if($('#dependency-setup-modal'))return;let installer;try{installer=await api('/api/dependencies')}catch(e){return toast(e.message,true)}const pkg=installer.installer?.packages?.[0];const root=$('#modal-root');if(!root)return;if(!installer.installer?.supported||!pkg){root.insertAdjacentHTML('beforeend',`<section id="dependency-setup-modal" class="dependency-setup-modal" role="dialog" aria-modal="true" aria-labelledby="dependency-setup-title"><div class="dependency-setup-card"><button type="button" class="modal-close" aria-label="Close tool setup" onclick="closeDependencySetup()">×</button><span class="kicker">FIRST-TIME SETUP</span><h2 id="dependency-setup-title">Database tools</h2><p>Automatic downloads are not available for this server platform. Use the manual portable-tool instructions in the setup guide.</p><div class="callout dependency-warning">Supported automatic packages currently cover Windows x64 and Linux x64. Existing system tools and configured binary paths remain supported.</div><div class="form-actions"><button type="button" class="secondary" onclick="closeDependencySetup()">Close</button></div></div></section>`);document.body.classList.add('modal-open');return}root.insertAdjacentHTML('beforeend',`<section id="dependency-setup-modal" class="dependency-setup-modal" role="dialog" aria-modal="true" aria-labelledby="dependency-setup-title"><div class="dependency-setup-card"><button type="button" class="modal-close" aria-label="Close tool setup" onclick="closeDependencySetup()">×</button><span class="kicker">FIRST-TIME SETUP</span><h2 id="dependency-setup-title">Prepare database tools</h2><p>VaultBack can download the official MariaDB community client pack and use its compatible client and dump tools for both MySQL and MariaDB connections.</p><div class="dependency-package-card"><div><b>MariaDB ${esc(pkg.version)} portable client pack</b><small>Official source: ${esc(pkg.source||'MariaDB archive')}</small></div><span class="tag">Verified download</span></div><div class="callout">Only the command-line client tools are installed. No database server is installed, and your credentials are not sent to MariaDB.</div><div id="dependency-install-status" aria-live="polite"><div class="dependency-install-status"><div class="dependency-install-status-head"><b>Ready to download</b><span>Not started</span></div></div></div><div class="form-actions"><button type="button" class="secondary" onclick="closeDependencySetup()">Close</button><button type="button" class="primary" id="start-dependency-install">Download and install</button></div></div></section>`);document.body.classList.add('modal-open');const start=$('#start-dependency-install');const status=$('#dependency-install-status');start.onclick=async()=>{start.disabled=true;try{let job=await api('/api/dependencies/install',{method:'POST',body:JSON.stringify({})});status.innerHTML=dependencyInstallMarkup(job);while(!['completed','failed'].includes(job.state)){await new Promise(resolve=>setTimeout(resolve,900));job=await api(`/api/dependencies/install/${encodeURIComponent(job.id)}`);status.innerHTML=dependencyInstallMarkup(job)}if(job.state==='completed'){await loadHealthDetails();toast('Database tools are ready')}else start.disabled=false}catch(e){status.innerHTML=`<div class="callout dependency-warning">${esc(e.message)}</div>`;start.disabled=false}}}
function storageDescription(s){const c=s.config||{};return s.type==='local'?c.path||'Local path':s.type==='ftp'?`${c.host||'FTP host'} · ${c.remotePath||'/'}`:s.type==='webdav'?c.url||'WebDAV URL':s.type==='google-drive'?'Google Drive folder':`OneDrive · ${c.remotePath||'root'}`}
function field(label,name,value='',type='text',extra=''){return `<div class="field"><label>${label}</label><input name="${name}" type="${type}" value="${esc(value)}" ${extra}/></div>`}
function selectField(label,name,options,value=''){return `<div class="field"><label>${label}</label><select name="${name}">${options.map(o=>`<option value="${esc(o[0])}" ${o[0]===value?'selected':''}>${esc(o[1])}</option>`).join('')}</select></div>`}
async function deleteConnection(id){if(!await confirmAction('Delete this database and all schedules that use it?','Delete database connection'))return;try{await api(`/api/connections/${id}`,{method:'DELETE'});await loadAll();toast('Database deleted')}catch(e){toast(e.message,true)}}
async function deleteStorage(id){if(!await confirmAction('Delete this storage target and all schedules that use it?','Delete storage target'))return;try{await api(`/api/storage/${id}`,{method:'DELETE'});await loadAll();toast('Storage target deleted')}catch(e){toast(e.message,true)}}
async function deleteJob(id){if(!await confirmAction('Delete this schedule and its backup run history?','Delete schedule'))return;try{await api(`/api/jobs/${id}`,{method:'DELETE'});await loadAll();toast('Schedule deleted')}catch(e){toast(e.message,true)}}
async function testStorage(id){try{const r=await api(`/api/storage/${id}/test`,{method:'POST'});toast(r.message)}catch(e){toast(e.message,true)}}
// Bodyless POST endpoints must not receive an empty JSON body declaration.
async function api(url, options={}){const headers={...(options.headers||{})};if(options.body!==undefined)headers['Content-Type']='application/json';const opts={...options,headers};if(opts.method&&opts.method!=='GET'&&state.csrf&&!/\/api\/auth\/(?:login|setup)$/.test(url))opts.headers['x-csrf-token']=state.csrf;const r=await fetch(url,opts);let data={};try{data=await r.json()}catch{}if(!r.ok)throw new Error(data.message||'Request failed');return data}

async function downloadRunArtifact(button, id) {
  if (!button || button.disabled) return;
  const original = button.textContent || 'Download';
  button.disabled = true;
  button.textContent = 'Preparing…';
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}/download`, { credentials: 'same-origin' });
    if (!response.ok) {
      let message = 'Backup download failed';
      try { const data = await response.json(); message = data.message || message; } catch {}
      throw new Error(message);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = (response.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/i)?.[1] || `vaultback-backup-${id}.bin`).replace(/[\\/\0]/g, '_');
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    toast(error.message || 'Backup download failed', true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

document.addEventListener('click', event => {
  const link = event.target instanceof Element ? event.target.closest('a[href*="/api/runs/"][href$="/download"]') : null;
  if (!link) return;
  const match = link.getAttribute('href')?.match(/\/api\/runs\/([^/]+)\/download$/);
  if (!match) return;
  event.preventDefault();
  void downloadRunArtifact(link, decodeURIComponent(match[1]));
});

// Corrected form implementations: the original forms rendered a div and then
// passed it to FormData, which only accepts an HTMLFormElement.



function renderJobDatabaseScope(el, available, selected, scope){const host=el.querySelector('#job-database-scope');const chosen=new Set(selected);host.innerHTML=`<label>Backup scope</label><select name="databaseScope"><option value="selected" ${scope==='selected'?'selected':''}>Selected databases</option><option value="all" ${scope==='all'?'selected':''}>All databases</option></select><div id="job-database-checklist" style="margin-top:10px"></div>`;const draw=()=>{const all=host.querySelector('[name=databaseScope]').value==='all';const checklist=all?'<div class="callout">Every database visible to this account will be backed up.</div>':available.length?`<div style="display:grid;gap:8px;border:1px solid #deded7;border-radius:8px;padding:12px;background:#fff">${available.map(name=>`<label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" name="databases" value="${esc(name)}" ${chosen.has(name)?'checked':''} style="width:auto;padding:0;border:0;box-shadow:none">${esc(name)}</label>`).join('')}</div>`:'<div class="callout">No databases were returned for this connection.</div>';host.querySelector('#job-database-checklist').innerHTML=checklist};host.querySelector('[name=databaseScope]').onchange=draw;draw()}

function showConnectionForm(item={}){const el=$('#connection-form');el.classList.remove('hidden');el.innerHTML=formShell(item.id?'Edit database':'Add database',field('Display name','name',item.name)+selectField('Engine','engine',[['mysql','MySQL'],['mariadb','MariaDB']],item.engine||'mysql')+field('Host','host',item.host||'127.0.0.1')+field('Port','port',item.port||3306,'number')+field('Username','username',item.username||'')+field('Password','password','','password',item.id?'placeholder="Leave blank to keep current; empty passwords are supported" autocomplete="new-password"':'placeholder="Optional" autocomplete="new-password"')+`<div class="field"><label>Transport security</label><select name="ssl"><option value="false" ${!item.ssl?'selected':''}>Standard connection</option><option value="true" ${item.ssl?'selected':''}>Require SSL/TLS</option></select></div>`);const form=el.querySelector('.form-shell');const friendlyError=(message)=>message==='Internal server error'?'Could not test connection. Check that the MySQL/MariaDB client is installed and the database is reachable.':message;const readData=()=>{const f=new FormData(form);const data=Object.fromEntries(f);return {id:item.id,...data,port:Number(f.get('port')),ssl:f.get('ssl')==='true'}};const testButton=document.createElement('button');testButton.type='button';testButton.className='secondary';testButton.id='test-connection';testButton.textContent='Test connection';el.querySelector('.form-actions').insertBefore(testButton,el.querySelector('#save-form'));testButton.onclick=async()=>{testButton.disabled=true;try{const result=await api('/api/connections/test',{method:'POST',body:JSON.stringify(readData())});if(!result.ok)throw new Error(result.message);toast(result.message||'Database connection successful')}catch(e){toast(friendlyError(e.message),true)}finally{testButton.disabled=false}};$('#save-form').onclick=async()=>{const save=$('#save-form');save.disabled=true;try{const data=readData();const result=await api('/api/connections/test',{method:'POST',body:JSON.stringify(data)});if(!result.ok)throw new Error(result.message);await api('/api/connections',{method:'POST',body:JSON.stringify(data)});toast(`${result.message}; database saved`);closeForms();await loadAll()}catch(e){toast(friendlyError(e.message),true)}finally{save.disabled=false}}}



function showAuth(setup){
  $('#auth-loading')?.classList.add('hidden');
  $('#app-shell')?.classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  const content=setup?`<h2>Set up your control plane</h2><p>Create the first administrator. This account is required to manage credentials and backup destinations.</p><div class="callout">Your encryption key is generated and kept with the application data directory. Back up that key together with the SQLite file.</div>${field('Admin username','username','','text','autocomplete="username"')}${field('Password','password','','password','autocomplete="new-password" minlength="12"')}<button class="primary" id="auth-submit" type="submit">Create administrator</button><div class="auth-note">Use at least 12 characters. Keep this admin account private.</div>`:`<h2>Welcome back</h2><p>Sign in to manage backup sources, schedules, and destinations.</p>${field('Username','username','','text','autocomplete="username"')}${field('Password','password','','password','autocomplete="current-password"')}<button class="primary" id="auth-submit" type="submit">Sign in</button>`;
  $('#auth-content').innerHTML=`${dependencyNotice()}<form id="auth-form">${content}</form>`;
  $('#auth-form').onsubmit=async(event)=>{
    event.preventDefault();
    const form=event.currentTarget;
    const f=new FormData(form);
    const button=$('#auth-submit');
    button.disabled=true;
    try{await api(setup?'/api/auth/setup':'/api/auth/login',{method:'POST',body:JSON.stringify(Object.fromEntries(f))});const me=await api('/api/auth/me');state.userId=me.userId||'';state.isPrimary=Boolean(me.isPrimary);state.csrf=me.csrfToken;state.role=me.role||'viewer';await loadHealthDetails();$('#auth-screen').classList.add('hidden');$('#app-shell')?.classList.remove('hidden');$('#user-avatar').textContent=String(me.username||f.get('username')||'A').slice(0,1).toUpperCase();await loadAll();if(setup&&state.dependencies&&!state.dependencies.ok)void openDependencySetup()}
    catch(e){toast(e.message||'Unable to continue',true);button.disabled=false}
  };
}
async function boot(){try{await api('/api/health');const status=await api('/api/auth/status');if(!status.setupComplete){showAuth(true);return}try{const me=await api('/api/auth/me');state.userId=me.userId||'';state.isPrimary=Boolean(me.isPrimary);state.csrf=me.csrfToken;state.role=me.role||'viewer';await loadHealthDetails();$('#user-avatar').textContent=me.username.slice(0,1).toUpperCase();$('#auth-loading')?.classList.add('hidden');$('#app-shell')?.classList.remove('hidden');await loadAll()}catch(e){if(state.encryption?.status==='error'){renderEncryptionBanner();toast(state.encryption.message,true)}else showAuth(false)}}catch(e){const loading=$('#auth-loading');if(loading)loading.innerHTML='<div class="auth-loading-card"><b>VaultBack</b><span>Unable to check the session. Refresh to try again.</span></div>';toast(e.message,true)}}
document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>setView(b.dataset.view));document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>setView(b.dataset.go));document.querySelectorAll('[data-view-link]').forEach(b=>b.onclick=()=>setView(b.dataset.viewLink));$('#new-connection').onclick=()=>showConnectionForm();$('#new-storage').onclick=()=>showStorageForm();$('#new-job').onclick=()=>{if(!state.connections.length||!state.storage.length){toast('Add a database and storage target first',true);return}showJobForm()};$('#refresh-runs').onclick=async()=>{state.runs=await api('/api/runs');renderRuns()};$('#logout').onclick=async()=>{try{await api('/api/auth/logout',{method:'POST'});location.reload()}catch(e){toast(e.message,true)}};setTimeout(()=>void boot(),0);

function showStorageForm(item={}){
  const el=$('#storage-form');el.classList.remove('hidden');const c=item.config||{};const type=item.type||'local';
  const common=selectField('Storage type','type',[['local','Local disk'],['ftp','FTP / FTPS'],['webdav','WebDAV / Synology'],['google-drive','Google Drive'],['onedrive','OneDrive']],type);
  el.innerHTML=formShell(item.id?'Edit storage target':'Add storage target',field('Display name','name',item.name)+common+`<div id="storage-guide-wrap" class="field full">${storageGuide(type)}</div>`+`<div id="storage-specific" class="form-grid full"></div>`);
  const draw=()=>{const selected=el.querySelector('[name=type]').value;$('#storage-guide-wrap').innerHTML=storageGuide(selected);$('#storage-specific').innerHTML=storageFields(selected,c)};
  el.querySelector('[name=type]').onchange=draw;draw();
  $('#save-form').onclick=async()=>{try{const form=el.querySelector('.form-shell');const f=new FormData(form);const data=Object.fromEntries(f);data.config={};el.querySelectorAll('#storage-specific [name]').forEach(input=>{data.config[input.name]=input.type==='checkbox'?input.checked:input.value});delete data.type;data.type=el.querySelector('[name=type]').value;await api('/api/storage',{method:'POST',body:JSON.stringify({id:item.id,...data})});toast('Storage target saved');closeForms();await loadAll()}catch(e){toast(e.message,true)}}
}

function vaultbackCronName(value, names) {
  const values = String(value).split(',').map(part => part.trim());
  const label = part => {
    const step = part.match(/^\*\/(\d+)$/);
    if (step) return `every ${step[1]} ${names.unit}${step[1] === '1' ? '' : 's'}`;
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) return `${names.get(range[1])} through ${names.get(range[2])}`;
    if (/^\d+$/.test(part)) return names.get(part);
    return part;
  };
  return values.map(label).join(', ');
}

function vaultbackCronHuman(expression) {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5 || parts.some(part => !part)) return 'Enter five fields: minute, hour, day of month, month, and day of week.';

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const monthName = value => /^\d+$/.test(value) ? (months[Number(value) - 1] || value) : value;
  const weekdayName = value => /^\d+$/.test(value) ? (weekdays[Number(value) % 7] || value) : value;
  const minuteLabel = value => vaultbackCronName(value, { unit: 'minute', get: v => /^\d+$/.test(v) ? `minute ${v}` : v });
  const hourLabel = value => vaultbackCronName(value, { unit: 'hour', get: v => /^\d+$/.test(v) ? `hour ${v}` : v });
  const formatTime = /^\d+$/.test(minute) && /^\d+$/.test(hour)
    ? `at ${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`
    : `at ${minuteLabel(minute)} of ${hourLabel(hour)}`;

  if (minute === '*/1' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return 'Every minute.';
  if (minute.match(/^\*\/\d+$/) && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return `Every ${minute.slice(2)} minutes.`;
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*' && /^\d+$/.test(minute) && /^\d+$/.test(hour)) return `Every day ${formatTime}.`;
  if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*' && /^\d+$/.test(minute) && /^\d+$/.test(hour)) return `Every ${vaultbackCronName(dayOfWeek, { unit: 'day', get: weekdayName })} ${formatTime}.`;
  if (dayOfMonth !== '*' && month === '*' && dayOfWeek === '*' && /^\d+$/.test(minute) && /^\d+$/.test(hour)) return `On day ${dayOfMonth} of every month ${formatTime}.`;
  if (dayOfMonth === '*' && month !== '*' && dayOfWeek === '*' && /^\d+$/.test(minute) && /^\d+$/.test(hour)) return `Every ${vaultbackCronName(month, { unit: 'month', get: monthName })} ${formatTime}.`;

  const dayText = dayOfMonth === '*' ? 'every day' : `on day ${dayOfMonth}`;
  const monthText = month === '*' ? '' : ` in ${vaultbackCronName(month, { unit: 'month', get: monthName })}`;
  const weekdayText = dayOfWeek === '*' ? '' : ` on ${vaultbackCronName(dayOfWeek, { unit: 'day', get: weekdayName })}`;
  return `${dayText}${monthText}${weekdayText}, ${formatTime}.`;
}

function vaultbackCronField(value) {
  return `<div class="field full cron-field"><label for="job-cron-expression">Cron expression <span class="cron-help" tabindex="0" role="img" aria-label="Cron format guide" data-tooltip="Five fields: minute hour day-of-month month day-of-week. Example: 0 2 * * * = every day at 02:00.">?</span></label><input id="job-cron-expression" name="cronExpression" type="text" value="${esc(value)}" autocomplete="off" spellcheck="false" placeholder="0 2 * * *"/><div id="cron-readable" class="cron-readable" aria-live="polite"></div><div class="cron-guide"><b>MINUTE</b> <b>HOUR</b> <b>DAY OF MONTH</b> <b>MONTH</b> <b>DAY OF WEEK</b><span>0–59&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0–23&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;1–31&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;1–12&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0–7</span></div></div>`;
}

function vaultbackAttachCronGuide(form) {
  const input = form.querySelector('#job-cron-expression');
  const readable = form.querySelector('#cron-readable');
  if (!input || !readable) return;
  const update = () => {
    const text = vaultbackCronHuman(input.value);
    readable.textContent = text;
    readable.classList.toggle('invalid', text.startsWith('Enter five fields'));
  };
  input.addEventListener('input', update);
  update();
}

function showJobForm(item = {}) {
  const el = $('#job-form');
  el.classList.remove('hidden');
  el.innerHTML = formShell(item.id ? 'Edit schedule' : 'Create schedule',
    field('Schedule name', 'name', item.name) +
    selectField('Database connection', 'databaseConnectionId', state.connections.map(x => [x.id, x.name]), item.databaseConnectionId) +
    selectField('Storage target', 'storageTargetId', state.storage.map(x => [x.id, x.name]), item.storageTargetId) +
    '<div id="job-database-scope" class="field full"><span class="hint">Loading available databases…</span></div>' +
    vaultbackCronField(item.cronExpression || '0 2 * * *') +
    field('Timezone', 'timezone', item.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone) +
    selectField('Backup layout', 'backupLayout', [['single', 'Single SQL file'], ['database', 'One SQL file per database (ZIP)'], ['table', 'One SQL file per table (ZIP)']], item.backupLayout || 'single') +
    selectField('Compression', 'compression', [['gzip', 'GZIP (.sql.gz)'], ['zip', 'ZIP archive (.zip)'], ['none', 'None (.sql)']], item.compression || 'gzip') +
    selectField('Backup encryption', 'backupEncryption', [['none', 'None'], ['aes-256-gcm', 'AES-256-GCM (recommended)']], item.backupEncryption || 'none') +
    field('Retention count', 'retentionCount', item.retentionCount || 7, 'number', 'min="1" max="365"') +
    field('Filename prefix', 'filenamePrefix', item.filenamePrefix || 'database-backup') +
    selectField('Status', 'enabled', [['true', 'Active'], ['false', 'Paused']], item.enabled === false ? 'false' : 'true') +
    '<div class="field full"><span class="hint">Choose all databases or select specific databases from the list returned by the connection.</span></div>'
  );

  vaultbackAttachCronGuide(el);
  const layoutSelect = el.querySelector('[name="backupLayout"]');
  const compressionSelect = el.querySelector('[name="compression"]');
  const layoutHint = document.createElement('div');
  layoutHint.className = 'field full';
  layoutHint.innerHTML = '<span class="hint">Split layouts create a ZIP with DatabaseName/DatabaseName.sql or DatabaseName/TableName.sql entries. All tables are included for each selected database.</span>';
  compressionSelect?.closest('.field')?.after(layoutHint);
  const updateLayoutOptions = () => {
    const split = layoutSelect?.value !== 'single';
    if (compressionSelect) { if (split) compressionSelect.value = 'zip'; compressionSelect.disabled = split; }
    layoutHint.classList.toggle('hidden', !split);
  };
  layoutSelect?.addEventListener('change', updateLayoutOptions);
  updateLayoutOptions();
  let firstLoad = true;
  const loadDatabases = async () => {
    const id = el.querySelector('[name=databaseConnectionId]').value;
    try {
      const result = await api(`/api/connections/${encodeURIComponent(id)}/databases`);
      renderJobDatabaseScope(el, result.databases || [], firstLoad ? (item.databases || []) : [], firstLoad ? (item.databaseScope || 'selected') : 'selected');
    } catch (e) {
      const detail = e.message === 'Internal server error' ? 'Check that the MySQL/MariaDB client and connection are reachable.' : e.message;
      el.querySelector('#job-database-scope').innerHTML = `<div class="callout">Unable to load databases: ${esc(detail)}</div>`;
    } finally {
      firstLoad = false;
    }
  };
  el.querySelector('[name=databaseConnectionId]').onchange = loadDatabases;
  void loadDatabases();

  $('#save-form').onclick = async () => {
    try {
      const form = el.querySelector('.form-shell');
      const f = new FormData(form);
      const data = Object.fromEntries(f);
      data.databases = [...form.querySelectorAll('input[name="databases"]:checked')].map(input => input.value);
      data.databaseScope = form.querySelector('[name="databaseScope"]')?.value || 'selected';
      data.retentionCount = Number(data.retentionCount);
      data.enabled = data.enabled === 'true';
      await api('/api/jobs', { method: 'POST', body: JSON.stringify({ id: item.id, ...data }) });
      toast('Schedule saved');
      closeForms();
      await loadAll();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

const vaultbackViewRoutes = {
  '/': 'dashboard',
  '/overview': 'dashboard',
  '/databases': 'connections',
  '/connections': 'connections',
  '/storage': 'storage',
  '/schedules': 'jobs',
  '/jobs': 'jobs',
  '/history': 'runs',
  '/runs': 'runs',
  '/guide': 'guide',
  '/help': 'guide',
  '/settings': 'settings',
  '/sessions': 'sessions'
};

const vaultbackViewPaths = { dashboard: '/', connections: '/databases', storage: '/storage', jobs: '/schedules', runs: '/history', guide: '/guide', settings: '/settings', sessions: '/sessions' };

function vaultbackRouteView() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return vaultbackViewRoutes[path] || 'not-found';
}

function setView(view, options = {}) {
  const restrictedBeforeAuth = view === 'sessions' && state.csrf && state.role !== 'admin';
  const nextView = restrictedBeforeAuth ? 'not-found' : (view === 'not-found' ? 'not-found' : (vaultbackViewPaths[view] ? view : 'not-found'));
  state.currentView = nextView;
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `view-${nextView}`));
  document.querySelectorAll('.nav-item').forEach(el => {
    const active = el.dataset.view === nextView;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  const title = { dashboard: 'Overview', connections: 'Databases', storage: 'Storage targets', jobs: 'Schedules', runs: 'Backup history', processes: 'Live processes', guide: 'Setup guide', settings: 'Settings', sessions: 'Sessions & rate limit', 'not-found': 'Page not found' }[nextView];
  $('#section-title').textContent = title;
  $('#section-eyebrow').textContent = { dashboard: 'OPERATIONS CENTER', connections: 'SOURCE DATABASES', storage: 'DELIVERY DESTINATIONS', jobs: 'AUTOMATION', runs: 'AUDIT TRAIL', processes: 'LIVE OPERATIONS', guide: 'HELP CENTER', settings: 'CONTROL PLANE', sessions: 'SECURITY CENTER', 'not-found': 'ERROR 404' }[nextView];
  document.title = `${title} · VaultBack`;
  if (options.history !== false) {
    const target = vaultbackViewPaths[nextView];
    const current = window.location.pathname.replace(/\/+$/, '') || '/';
    if (target && current !== target) {
      const method = options.replace ? 'replaceState' : 'pushState';
      window.history[method]({ view: nextView }, '', target);
    }
  }
  if (nextView === 'dashboard') renderDashboard();
  if (nextView === 'connections') renderConnections();
  if (nextView === 'storage') renderStorage();
  if (nextView === 'jobs') renderJobs();
  if (nextView === 'runs') renderRuns();
  if (nextView === 'processes') { renderProcesses(); if (state.csrf) void loadLiveProcesses(); }
  if (nextView === 'settings') renderSettings();
  if (nextView === 'sessions' && state.role === 'admin') { renderSessions(); if (state.csrf) void loadSessions(); }
  syncLiveProcessPolling();
  syncSessionsRefreshPolling();
}

window.addEventListener('popstate', () => setView(vaultbackRouteView(), { history: false }));
setView(vaultbackRouteView(), { history: false });

const processStageLabels = { preparing: 'Preparing', dumping: 'Dumping database', compressing: 'Compressing', encrypting: 'Encrypting', verifying: 'Verifying archive', uploading: 'Uploading', rotating: 'Applying rotation', completed: 'Completed', failed: 'Failed' };
function processDuration(item) { const start = Date.parse(item.startedAt); const end = item.finishedAt ? Date.parse(item.finishedAt) : Date.now(); if (!Number.isFinite(start)) return '—'; const seconds = Math.max(0, Math.floor((end - start) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }

function formShell(title, body) {
  return `<form class="form-shell" onsubmit="return false"><button type="button" class="modal-close" aria-label="Close dialog" onclick="closeForms()">×</button><h3>${title}</h3><div class="form-grid">${body}</div><div class="form-actions"><button type="button" class="secondary" onclick="closeForms()">Cancel</button><button type="button" class="primary" id="save-form">Save changes</button></div></form>`;
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.querySelector('.form-panel:not(.hidden)')) closeForms();
});
document.addEventListener('click', event => {
  if (event.target instanceof Element && event.target.matches('.form-panel:not(.hidden)')) closeForms();
});

function formatCapacity(value) { if (value === null || value === undefined) return 'Unavailable'; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`; return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`; }
function updateNotificationFields() { const telegram = $('#notification-provider').value === 'telegram'; $('#notification-webhook-fields').classList.toggle('hidden', telegram); $('#notification-telegram-fields').classList.toggle('hidden', !telegram); }
async function saveNotifications() { try { await api('/api/settings/notifications', { method: 'POST', body: JSON.stringify({ enabled: $('#notification-enabled').checked, provider: $('#notification-provider').value, webhookUrl: $('#notification-webhook-url').value, webhookToken: $('#notification-webhook-token').value, botToken: $('#notification-bot-token').value, chatId: $('#notification-chat-id').value, events: { backup_success: $('#notify-success').checked, backup_failed: $('#notify-failed').checked, capacity_warning: $('#notify-capacity').checked } }) }); toast('Notification settings saved'); state.notifications = await api('/api/settings/notifications'); renderSettings(); } catch (e) { toast(e.message, true); } }
async function deleteUser(id) { if (!await confirmAction('Remove this user account? Existing sessions for the account will stop working.','Delete user')) return; try { await api(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadCollection('users'); toast('User deleted'); } catch (e) { toast(e.message, true); } }
async function exportSafeConfig() { try { const data = await api('/api/settings/export'); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `vaultback-config-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); toast('Safe configuration exported'); } catch (e) { toast(e.message, true); } }

function openSetupWizard() { const wizard = $('#setup-wizard'); wizard.innerHTML = `<div class="setup-wizard-card"><button class="modal-close" aria-label="Close guided setup" onclick="closeSetupWizard()">×</button><span class="kicker">FIRST-TIME SETUP</span><h2>Let’s make your first backup</h2><p>Complete these four steps. You can leave and return at any time.</p><div class="wizard-step"><b>1. Add a database</b><span>Connect MySQL or MariaDB and test the credentials.</span><button class="secondary" onclick="closeSetupWizard();setView('connections')">Open Databases</button></div><div class="wizard-step"><b>2. Add storage</b><span>Choose local disk, FTP/FTPS, Synology, or cloud storage.</span><button class="secondary" onclick="closeSetupWizard();setView('storage')">Open Storage</button></div><div class="wizard-step"><b>3. Create a schedule</b><span>Select databases, time, retention, compression, and encryption.</span><button class="secondary" onclick="closeSetupWizard();setView('jobs')">Open Schedules</button></div><div class="wizard-step"><b>4. Run and verify</b><span>Run one backup manually, then check Backup history.</span><button class="secondary" onclick="closeSetupWizard();setView('runs')">Open History</button></div></div>`; wizard.classList.remove('hidden'); }
function closeSetupWizard() { $('#setup-wizard').classList.add('hidden'); }

// The API never returns secret fields. On edit these inputs remain blank and
// the server preserves the existing encrypted value when blank is submitted.
function storageFields(type, c) {
  const keep = 'placeholder="Leave blank to keep current" autocomplete="new-password"';
  if (type === 'local') return field('Directory path', 'path', c.path || './data/backups', 'text', 'placeholder="./data/backups"');
  if (type === 'ftp') return field('Host', 'host', c.host || '') + field('Port', 'port', c.port || 21, 'number') + field('Username', 'username', c.username || '') + field('Password', 'password', '', 'password', keep) + field('Remote directory', 'remotePath', c.remotePath || '/backups') + selectField('Security', 'secure', [['false', 'FTP'], ['true', 'FTPS']], String(c.secure || false));
  if (type === 'webdav') return field('WebDAV URL', 'url', c.url || '', 'url') + field('Username', 'username', c.username || '') + field('Password', 'password', '', 'password', keep) + field('Bearer token', 'token', '', 'password', keep) + `<label class="field full checkbox-field"><span><input name="allowSelfSigned" type="checkbox" value="true" ${c.allowSelfSigned ? 'checked' : ''} /> Allow self-signed certificate <span class="optional">Less secure</span></span><small class="hint">Use only on a trusted private network. The safer option is using the NAS certificate hostname or installing its CA certificate on the VaultBack host.</small></label>`;
  if (type === 'google-drive') return field('Access token', 'accessToken', '', 'password', keep) + field('Refresh token', 'refreshToken', '', 'password', keep) + field('OAuth client ID', 'clientId', '') + field('OAuth client secret', 'clientSecret', '', 'password', keep) + field('Folder ID', 'folderId', c.folderId || '') + '<div class="field full"><span class="hint">For automatic token renewal, fill all four OAuth fields. Otherwise only an access token is needed until it expires.</span></div>';
  return field('Access token', 'accessToken', '', 'password', keep) + field('Refresh token', 'refreshToken', '', 'password', keep) + field('OAuth client ID', 'clientId', '') + field('OAuth client secret', 'clientSecret', '', 'password', keep) + field('Tenant ID', 'tenantId', c.tenantId || 'common') + field('Remote path', 'remotePath', c.remotePath || 'vaultback/backup.sql.gz') + '<div class="field full"><span class="hint">Use common for personal accounts. Use your Microsoft Entra tenant ID for organization accounts.</span></div>';
}

function storageGuide(type) {
  const guides = {
    local: ['Local disk', 'Backups stay on the machine running VaultBack.', ['Use the app-managed backup directory or an approved deployment path.', 'Make sure the service account can create and write files there.', 'Save the target, then use Test on its storage card.'], 'Local paths are restricted to the application backup directory unless ALLOW_ANY_LOCAL_PATH=true is explicitly enabled.'],
    ftp: ['FTP / FTPS', 'Use a dedicated account limited to the backup directory.', ['Enter the server hostname, port, username, and password.', 'Choose FTPS whenever the server supports TLS.', 'Create the remote directory first, then use Test.'], 'Plain FTP exposes credentials and should only be used on a trusted private network.'],
    webdav: ['WebDAV / Synology', 'Synology NAS devices can receive backups through WebDAV.', ['Enable WebDAV Server on Synology and create a dedicated user.', 'Use the HTTPS WebDAV URL and the shared-folder path.', 'Enter the credentials or bearer token, then use Test.', 'Use the NAS certificate hostname instead of its IP address. If the NAS uses a private self-signed certificate, enable the explicit less-secure option in the form only on a trusted private network.'], 'Certificate verification is enabled by default. Prefer installing the NAS CA certificate or using a trusted certificate hostname; never disable verification for an internet-facing NAS.'],
    'google-drive': ['Google Drive', 'Use an access token for quick setup or refresh-token OAuth credentials for unattended schedules.', ['Create a Google Cloud OAuth client and grant only the Drive permission needed to upload backups.', 'Enter an access token, or enter refresh token, client ID, and client secret for automatic renewal.', 'Copy the folder ID from the Drive URL, then click Test.'], 'Tokens and OAuth secrets are encrypted before storage and are never returned to the browser.'],
    onedrive: ['OneDrive', 'Use Microsoft Graph OAuth credentials for scheduled uploads.', ['Register an app in Microsoft Entra ID and add delegated Files.ReadWrite permission.', 'Enter an access token, or refresh token, client ID, and client secret for automatic renewal.', 'Use common for personal accounts or enter your tenant ID, then click Test.'], 'Tokens and OAuth secrets are encrypted before storage and are never returned to the browser.']
  };
  const guide = guides[type] || guides.local;
  const links = type === 'webdav' ? '<p><a href="https://kb.synology.com/en-nz/DSM/tutorial/How_to_access_files_on_Synology_NAS_with_WebDAV" target="_blank" rel="noreferrer">Open Synology WebDAV instructions ↗</a></p>' : type === 'google-drive' ? '<p><a href="https://developers.google.com/identity/protocols/oauth2/web-server" target="_blank" rel="noreferrer">Open Google OAuth instructions ↗</a> · <a href="https://developers.google.com/oauthplayground/" target="_blank" rel="noreferrer">Open OAuth Playground ↗</a></p>' : type === 'onedrive' ? '<p><a href="https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow" target="_blank" rel="noreferrer">Open Microsoft OAuth instructions ↗</a> · <a href="https://learn.microsoft.com/en-us/graph/permissions-reference" target="_blank" rel="noreferrer">View Graph permissions ↗</a></p>' : '';
  return `<details class="storage-guide" open><summary><span>How to configure ${guide[0]}</span><span class="guide-badge">Guide</span></summary><div class="storage-guide-body"><p>${guide[1]}</p><ol>${guide[2].map(step => `<li>${step}</li>`).join('')}</ol>${links}<div class="storage-guide-note">${guide[3]}</div></div></details>`;
}

function updateRoleUi() {
  const canConfigure = state.role === 'admin';
  ['new-connection', 'new-storage', 'new-job'].forEach(id => {
    const button = document.getElementById(id);
    if (button) { button.classList.toggle('hidden', !canConfigure); button.disabled = !canConfigure; }
  });
  document.querySelectorAll('.admin-only-nav').forEach(item => item.classList.toggle('hidden', !canConfigure));
}

function mountFormModal(id) {
  const root = document.getElementById('modal-root');
  const form = document.getElementById(id);
  if (root && form && form.parentElement !== root) root.appendChild(form);
  document.body.classList.add('modal-open');
}

function closeForms() { ['connection-form', 'storage-form', 'job-form'].forEach(id => { const form = document.getElementById(id); if (form) { form.classList.add('hidden'); form.innerHTML = ''; } }); if ($('#user-form')?.classList.contains('hidden')) document.body.classList.remove('modal-open'); }

function editConnection(id) { mountFormModal('connection-form'); showConnectionForm(state.connections.find(x => x.id === id)); }
function editStorage(id) { mountFormModal('storage-form'); showStorageForm(state.storage.find(x => x.id === id)); }
function editJob(id) { mountFormModal('job-form'); showJobForm(state.jobs.find(x => x.id === id)); }
document.getElementById('new-connection').onclick = () => { mountFormModal('connection-form'); showConnectionForm(); };
document.getElementById('new-storage').onclick = () => { mountFormModal('storage-form'); showStorageForm(); };
document.getElementById('new-job').onclick = () => { if (!state.connections.length || !state.storage.length) { toast('Add a database and storage target first', true); return; } mountFormModal('job-form'); showJobForm(); };

function collectionQuery(key) { const options = state.list[key]; const params = new URLSearchParams({ page: String(options.page), pageSize: String(options.pageSize) }); if (options.search) params.set('search', options.search); if (options.status) params.set('status', options.status); return `?${params}`; }
function collectionControls(key, targetId, placeholder, withStatus = false) {
  const host = document.getElementById(targetId); if (!host || host.dataset.bound) return;
  host.innerHTML = `<div class="list-toolbar"><input id="${key}-search" type="search" placeholder="${placeholder}" autocomplete="off" /><select id="${key}-page-size" aria-label="${key} page size"><option value="25">25 per page</option><option value="50">50 per page</option><option value="100">100 per page</option></select>${withStatus ? `<select id="${key}-status" aria-label="Backup status"><option value="">All statuses</option><option value="success">Success</option><option value="failed">Failed</option><option value="running">Running</option></select>` : ''}<span id="${key}-summary" class="list-summary"></span></div>`;
  const search = document.getElementById(`${key}-search`); const size = document.getElementById(`${key}-page-size`); const status = withStatus ? document.getElementById(`${key}-status`) : null; if (!search || !size) { host.dataset.bound = '1'; return; } search.value = state.list[key].search || ''; size.value = String(state.list[key].pageSize); if (status) status.value = state.list[key].status || '';
  const refresh = () => { state.list[key].search = search.value.trim(); state.list[key].page = 1; if (status) state.list[key].status = status.value; void loadCollection(key); };
  search.addEventListener('input', () => { clearTimeout(vaultbackSearchTimers[key]); vaultbackSearchTimers[key] = setTimeout(refresh, 300); });
  size.addEventListener('change', () => { state.list[key].pageSize = Number(size.value); state.list[key].page = 1; void loadCollection(key); });
  if (status) status.addEventListener('change', refresh);
  host.dataset.bound = '1';
}
function renderCollectionPagination(key, targetId) {
  const host = document.getElementById(targetId); if (!host) return; const meta = state.meta[key] || { page: 1, pageSize: 25, pageCount: 1, total: 0 }; const first = meta.total ? ((meta.page - 1) * meta.pageSize) + 1 : 0; const last = Math.min(meta.total, meta.page * meta.pageSize); host.innerHTML = `<div class="pagination"><span>Showing ${first}–${last} of ${meta.total}</span><div><button class="small-button" data-page="first" ${meta.page <= 1 ? 'disabled' : ''}>First</button><button class="small-button" data-page="prev" ${meta.page <= 1 ? 'disabled' : ''}>Previous</button><b>Page ${meta.page} of ${meta.pageCount}</b><button class="small-button" data-page="next" ${meta.page >= meta.pageCount ? 'disabled' : ''}>Next</button><button class="small-button" data-page="last" ${meta.page >= meta.pageCount ? 'disabled' : ''}>Last</button></div></div>`; host.querySelectorAll('button[data-page]').forEach(button => button.onclick = () => { const action = button.dataset.page; state.list[key].page = action === 'first' ? 1 : action === 'last' ? meta.pageCount : action === 'prev' ? Math.max(1, meta.page - 1) : Math.min(meta.pageCount, meta.page + 1); void loadCollection(key); }); const summary = document.getElementById(`${key}-summary`); if (summary) summary.textContent = meta.total ? `${meta.total} total` : 'No matches'; }
async function loadCollection(key) { const result = await api(`${vaultbackCollectionEndpoints[key]}${collectionQuery(key)}`); state[key] = result.items || []; state.meta[key] = result; if (key === 'connections') renderConnections(); if (key === 'storage') renderStorage(); if (key === 'jobs') renderJobs(); if (key === 'runs') renderRuns(); if (key === 'users') renderSettings(); renderCollectionPagination(key, `${key}-pagination`); if (key === 'users') renderCollectionPagination(key, 'users-pagination'); if (key === 'runs') renderDashboard(); }

function renderConnections() { collectionControls('connections', 'connections-controls', 'Search name, host, user, or database'); const el = $('#connections-list'); const actions = state.role === 'admin' ? c => `<button class="small-button" onclick="editConnection('${c.id}')">Edit</button><button class="small-button danger" onclick="deleteConnection('${c.id}')">Delete</button>` : () => '<span class="hint">Administrator access is required to change credentials.</span>'; el.innerHTML = state.connections.map(c => `<article class="card"><div class="card-top"><div><h3>${esc(c.name)}</h3><p>${esc(c.username)}@${esc(c.host)}:${c.port}</p></div><span class="tag">${esc(c.engine)}</span></div><div class="card-meta"><span>Credentials</span><b>Encrypted</b></div><div class="card-actions">${actions(c)}</div></article>`).join('') || '<div class="empty">No database connections match this search.</div>'; renderCollectionPagination('connections', 'connections-pagination'); }
function renderStorage() { collectionControls('storage', 'storage-controls', 'Search storage name or type'); const el = $('#storage-list'); const actions = state.role === 'admin' ? s => `<button class="small-button" onclick="testStorage('${s.id}')">Test</button><button class="small-button" onclick="editStorage('${s.id}')">Edit</button><button class="small-button danger" onclick="deleteStorage('${s.id}')">Delete</button>` : s => `<button class="small-button" onclick="testStorage('${s.id}')">Test</button><span class="hint">Administrator access is required to change credentials.</span>`; el.innerHTML = state.storage.map(s => `<article class="card"><div class="card-top"><div><h3>${esc(s.name)}</h3><p>${esc(storageDescription(s))}</p></div><span class="tag">${esc(s.type)}</span></div><div class="card-meta"><span>Credentials</span><b>Encrypted</b></div><div class="card-actions">${actions(s)}</div></article>`).join('') || '<div class="empty">No storage targets match this search.</div>'; renderCollectionPagination('storage', 'storage-pagination'); }
function renderJobs() { collectionControls('jobs', 'jobs-controls', 'Search schedule, database, storage, or cron'); const el = $('#jobs-list'); const admin = state.role === 'admin'; el.innerHTML = state.jobs.map(j => { const db = state.connections.find(c => c.id === j.databaseConnectionId); const st = state.storage.find(s => s.id === j.storageTargetId); const configActions = admin ? `<button class="small-button" onclick="editJob('${j.id}')">Edit</button><button class="small-button danger" onclick="deleteJob('${j.id}')">Delete</button>` : ''; const layout = j.backupLayout === 'database' ? 'Per database' : j.backupLayout === 'table' ? 'Per table' : 'Single file'; const compression = j.compression === 'gzip' ? 'GZIP' : j.compression === 'zip' ? 'ZIP' : 'RAW'; return `<article class="card"><div class="card-top"><div><h3>${esc(j.name)}</h3><p>${esc(db?.name || 'Missing database')} → ${esc(st?.name || 'Missing target')}</p></div><span class="tag">${j.enabled ? 'ACTIVE' : 'PAUSED'}</span></div><div class="card-meta"><span>${esc(j.cronExpression)} · ${esc(j.timezone)}</span><b>${layout} · ${compression} · ${j.retentionCount} kept</b></div><div class="card-meta"><span>Protection</span><b>${j.backupEncryption === 'aes-256-gcm' ? 'AES-256-GCM' : 'Archive only'}</b></div><div class="card-meta"><span>Next run</span><b>${fmtDate(j.nextRunAt)}</b></div><div class="card-actions"><button class="small-button" onclick="runJob('${j.id}')">Run now</button><button class="small-button" id="job-runs-button-${j.id}" onclick="viewJobRuns('${j.id}')">View backups</button>${configActions}</div><div id="job-runs-${j.id}" class="job-runs hidden"></div></article>`; }).join('') || '<div class="empty">No schedules match this search.</div>'; renderCollectionPagination('jobs', 'jobs-pagination'); }

function overviewDateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
}

function overviewStatusLabel(status) {
  return status === 'success' ? 'Successful' : status === 'failed' ? 'Failed' : status === 'running' ? 'Running' : String(status || 'Unknown');
}

function renderDashboard() {
  const jobsMeta = state.meta.jobs || {};
  const storageMeta = state.meta.storage || {};
  const runsMeta = state.meta.runs || {};
  const totalJobs = Number(jobsMeta.total ?? state.jobs.length);
  const activeJobs = Number(jobsMeta.activeTotal ?? state.jobs.filter(job => job.enabled).length);
  const totalStorage = Number(storageMeta.total ?? state.storage.length);
  const success = Number(runsMeta.successTotal ?? state.runs.filter(run => run.status === 'success').length);
  const failed = Number(runsMeta.failedTotal ?? state.runs.filter(run => run.status === 'failed').length);
  const running = state.runs.filter(run => run.status === 'running').length;
  const activeSchedules = state.jobs.filter(job => job.enabled && job.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
  const nextJob = activeSchedules[0];
  const latest = state.runs[0];
  const health = failed > 0 ? 'Attention' : success > 0 ? 'Healthy' : 'Awaiting data';
  const healthDetail = failed > 0 ? `${failed} failed run${failed === 1 ? '' : 's'} need review` : success > 0 ? `${success} successful run${success === 1 ? '' : 's'} recorded` : 'Run a schedule to verify delivery';
  const headline = failed > 0 ? 'Backup attention required.' : !state.connections.length || !totalStorage || !totalJobs ? 'Complete your backup setup.' : !success ? 'Ready for your first backup.' : 'Backups are on track.';
  const subtitle = failed > 0 ? 'Review the latest failure, confirm the destination is reachable, and retry when the cause is resolved.' : 'Monitor schedule coverage, delivery readiness, and the latest recovery point from one place.';

  $('#overview-headline').textContent = headline;
  $('#overview-subtitle').textContent = subtitle;
  $('#metric-health').textContent = health;
  $('#metric-health-detail').textContent = healthDetail;
  $('.overview-health-card')?.classList.toggle('is-attention', failed > 0);
  $('#metric-jobs').textContent = activeJobs;
  $('#metric-jobs-detail').textContent = `${totalJobs} total schedule${totalJobs === 1 ? '' : 's'}`;
  $('#metric-storage').textContent = totalStorage;
  $('#metric-storage-detail').textContent = totalStorage ? 'configured delivery target' + (totalStorage === 1 ? '' : 's') : 'Add a destination to deliver backups';
  $('#metric-next').textContent = nextJob ? overviewDateLabel(nextJob.nextRunAt) : '—';
  $('#metric-next-detail').textContent = nextJob ? nextJob.name : 'No active schedule';

  $('#overview-upcoming').innerHTML = activeSchedules.slice(0, 4).map(job => {
    const storage = state.storage.find(target => target.id === job.storageTargetId);
    return `<div class="overview-schedule-row"><span class="overview-schedule-dot"></span><div><b>${esc(job.name)}</b><small>${esc(storage?.name || 'Storage target missing')}</small></div><time>${esc(overviewDateLabel(job.nextRunAt))}</time></div>`;
  }).join('') || `<div class="overview-empty"><b>${totalJobs ? 'No active schedules' : 'No schedules yet'}</b><span>${totalJobs ? 'Enable a schedule to keep the next recovery point moving.' : 'Create a schedule after adding a database and storage target.'}</span><button type="button" class="small-button" onclick="setView('jobs')">Open schedules</button></div>`;

  if (latest) {
    const latestStatus = overviewStatusLabel(latest.status);
    const verification = latest.verificationStatus === 'passed' ? 'Archive verified' : latest.verificationStatus || 'Not verified';
    $('#overview-latest').innerHTML = `<div class="overview-latest-status ${latest.status === 'failed' ? 'is-failed' : latest.status === 'success' ? 'is-success' : 'is-running'}"><span class="status-dot"></span><b>${latestStatus}</b><time>${esc(fmtDate(latest.startedAt))}</time></div><h4>${esc(latest.jobName || 'Backup run')}</h4><p class="overview-artifact">${esc(latest.filename || latest.errorMessage || (latest.status === 'running' ? 'Backup is still running…' : 'No artifact recorded'))}</p><div class="overview-detail-grid"><div><span>Artifact size</span><b>${esc(fmtBytes(latest.sizeBytes))}</b></div><div><span>Verification</span><b>${esc(verification)}</b></div></div>${latest.status === 'failed' ? `<div class="overview-error">${esc(latest.errorMessage || 'The latest backup failed before an artifact was stored.')}</div>` : ''}`;
  } else {
    $('#overview-latest').innerHTML = '<div class="overview-empty"><b>No backup has run yet</b><span>Your first successful run becomes the recovery point shown here.</span><button type="button" class="small-button" onclick="setView(\'jobs\')">Review schedules</button></div>';
  }

  $('#recent-runs').innerHTML = state.runs.slice(0, 5).map(run => `<div class="activity"><span class="activity-mark ${run.status === 'failed' ? 'fail' : run.status === 'running' ? 'running' : ''}"></span><div><b>${esc(run.jobName || 'Backup run')} <span class="activity-status">${esc(overviewStatusLabel(run.status))}</span></b><small>${esc(run.filename || run.errorMessage || 'Backup in progress…')}</small></div><time>${esc(fmtDate(run.startedAt))}</time></div>`).join('') || '<div class="empty">No backup runs yet. Create a schedule to get started.</div>';

  const checks = [
    { ready: state.connections.length > 0, title: state.connections.length > 0 ? 'Source database configured' : 'Add a source database', detail: state.connections.length > 0 ? `${state.connections.length} connection${state.connections.length === 1 ? '' : 's'} available for schedules.` : 'Add MySQL or MariaDB credentials, then test the connection.', view: 'connections' },
    { ready: totalStorage > 0, title: totalStorage > 0 ? 'Delivery target configured' : 'Add a delivery target', detail: totalStorage > 0 ? `${totalStorage} destination${totalStorage === 1 ? '' : 's'} available for backup files.` : 'Choose local disk, FTP, WebDAV, Google Drive, or OneDrive.', view: 'storage' },
    { ready: activeJobs > 0, title: activeJobs > 0 ? 'Automated schedule is active' : totalJobs > 0 ? 'Enable a schedule' : 'Create an automated schedule', detail: activeJobs > 0 ? `${activeJobs} schedule${activeJobs === 1 ? '' : 's'} will create future recovery points.` : 'Run a test backup before relying on the schedule.', view: 'jobs' }
  ];
  if (failed > 0) checks.unshift({ ready: false, title: 'Review failed backup runs', detail: `${failed} failed run${failed === 1 ? '' : 's'} may need a retry or destination fix.`, view: 'runs' });
  if (running > 0) checks.unshift({ ready: true, title: `${running} backup${running === 1 ? '' : 's'} running now`, detail: 'Live progress is available from the process indicator.', view: 'processes' });
  $('#readiness').innerHTML = checks.slice(0, 4).map(check => `<button type="button" class="check-row ${check.ready ? 'is-ready' : 'is-attention'}" onclick="setView('${check.view}')"><span class="check-icon">${check.ready ? '✓' : '→'}</span><span><h4>${esc(check.title)}</h4><p>${esc(check.detail)}</p></span><span class="check-arrow">→</span></button>`).join('');
}
async function runJob(id) { try { await api(`/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' }); await loadCollection('runs'); toast('Backup completed; history updated'); } catch (e) { await loadCollection('runs').catch(() => {}); toast(e.message, true); } }
async function retryRun(id) { try { await api(`/api/runs/${encodeURIComponent(id)}/retry`, { method: 'POST' }); await loadCollection('runs'); toast('Backup retry started'); } catch (e) { toast(e.message, true); } }

function isMobileSidebarViewport() {
  return window.matchMedia('(max-width: 767px)').matches;
}

function isTabletSidebarViewport() {
  return window.matchMedia('(min-width: 768px) and (max-width: 1023px)').matches;
}

function isSidebarCompact() {
  const shell = document.getElementById('app-shell');
  if (!shell) return false;
  if (isTabletSidebarViewport()) return !shell.classList.contains('sidebar-tablet-expanded');
  return shell.classList.contains('sidebar-collapsed');
}

function getSidebarFocusableElements() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return [];
  return [...sidebar.querySelectorAll('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(element => !element.disabled && !element.classList.contains('hidden') && element.getClientRects().length > 0);
}

function ensureSidebarTooltip() {
  let tooltip = document.getElementById('sidebar-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'sidebar-tooltip';
    tooltip.className = 'sidebar-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function hideSidebarTooltip() {
  const tooltip = document.getElementById('sidebar-tooltip');
  if (tooltip) tooltip.classList.remove('visible');
}

function showSidebarTooltip(target) {
  const shell = document.getElementById('app-shell');
  if (!shell || isMobileSidebarViewport() || !isSidebarCompact()) return;
  const text = target.dataset.tooltip || target.getAttribute('aria-label');
  if (!text) return;
  const tooltip = ensureSidebarTooltip();
  tooltip.textContent = text;
  tooltip.classList.add('visible');
  const bounds = target.getBoundingClientRect();
  const top = Math.max(10, Math.min(window.innerHeight - 48, bounds.top + (bounds.height / 2) - 18));
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${Math.min(window.innerWidth - 12, bounds.right + 12)}px`;
}

function bindSidebarTooltips() {
  document.querySelectorAll('.sidebar [data-tooltip]').forEach(target => {
    if (target.dataset.tooltipBound) return;
    target.dataset.tooltipBound = '1';
    target.addEventListener('pointerenter', () => showSidebarTooltip(target));
    target.addEventListener('pointerleave', hideSidebarTooltip);
    target.addEventListener('focus', () => showSidebarTooltip(target));
    target.addEventListener('blur', hideSidebarTooltip);
  });
}

function updateSidebarControls() {
  const shell = document.getElementById('app-shell');
  const toggle = document.getElementById('sidebar-toggle');
  const mobileToggle = document.getElementById('mobile-menu-toggle');
  if (!shell) return;
  const mobile = isMobileSidebarViewport();
  const compact = isSidebarCompact();
  const open = shell.classList.contains('sidebar-open');
  const label = mobile ? (open ? 'Close navigation' : 'Open navigation') : (compact ? 'Expand sidebar' : 'Collapse sidebar');
  if (toggle) {
    toggle.classList.toggle('hidden', mobile && !open);
    toggle.setAttribute('aria-expanded', String(mobile ? open : !compact));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    const text = toggle.querySelector('.sidebar-toggle-label');
    if (text) text.textContent = label;
    const icon = toggle.querySelector('[aria-hidden="true"]');
    if (icon) icon.textContent = mobile ? '×' : (compact ? '›' : '‹');
  }
  if (mobileToggle) {
    mobileToggle.setAttribute('aria-expanded', String(open));
    mobileToggle.setAttribute('aria-label', label);
    mobileToggle.title = label;
    const icon = mobileToggle.querySelector('[aria-hidden="true"]');
    if (icon) icon.textContent = open ? '×' : '☰';
  }
}

function setSidebarCollapsed(collapsed) {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  const next = collapsed === true;
  document.documentElement.dataset.sidebar = next ? 'collapsed' : 'expanded';
  shell.classList.toggle('sidebar-collapsed', next);
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `vb_sidebar=${next ? 'collapsed' : 'expanded'}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
  updateSidebarControls();
}

function setMobileSidebarOpen(open, restoreFocus = false) {
  const shell = document.getElementById('app-shell');
  const sidebar = document.getElementById('primary-navigation');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!shell) return;
  const next = Boolean(open) && isMobileSidebarViewport();
  shell.classList.toggle('sidebar-open', next);
  document.body.classList.toggle('sidebar-scroll-lock', next);
  if (sidebar) {
    sidebar.setAttribute('aria-hidden', String(!next));
    if (next) {
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
    } else {
      sidebar.removeAttribute('role');
      sidebar.removeAttribute('aria-modal');
    }
  }
  if (backdrop) {
    backdrop.classList.toggle('hidden', !next);
    backdrop.setAttribute('aria-hidden', String(!next));
  }
  updateSidebarControls();
  if (next) requestAnimationFrame(() => document.getElementById('sidebar-toggle')?.focus());
  if (!next && restoreFocus) document.getElementById('mobile-menu-toggle')?.focus();
}

function initializeSidebar() {
  const shell = document.getElementById('app-shell');
  const sidebar = document.querySelector('.sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!shell || !sidebar || !toggle) return;
  let mobileToggle = document.getElementById('mobile-menu-toggle');
  if (!mobileToggle) {
    mobileToggle = document.createElement('button');
    mobileToggle.type = 'button';
    mobileToggle.id = 'mobile-menu-toggle';
    mobileToggle.className = 'mobile-menu-toggle';
    mobileToggle.setAttribute('aria-controls', 'primary-navigation');
    mobileToggle.setAttribute('aria-expanded', 'false');
    mobileToggle.setAttribute('aria-label', 'Open navigation');
    mobileToggle.title = 'Open navigation';
    mobileToggle.innerHTML = '<span aria-hidden="true">☰</span>';
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.insertBefore(mobileToggle, topbar.firstChild);
  }
  shell.classList.remove('sidebar-tablet-expanded');
  setSidebarCollapsed(document.documentElement.dataset.sidebar === 'collapsed');
  toggle.onclick = () => {
    if (isMobileSidebarViewport()) setMobileSidebarOpen(false, true);
    else if (isTabletSidebarViewport()) {
      shell.classList.toggle('sidebar-tablet-expanded', isSidebarCompact());
      hideSidebarTooltip();
      updateSidebarControls();
    }
    else setSidebarCollapsed(!shell.classList.contains('sidebar-collapsed'));
  };
  mobileToggle.onclick = () => setMobileSidebarOpen(!shell.classList.contains('sidebar-open'));
  backdrop?.addEventListener('click', () => setMobileSidebarOpen(false, true));
  document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => setMobileSidebarOpen(false, true)));
  bindSidebarTooltips();
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && shell.classList.contains('sidebar-open')) {
      event.preventDefault();
      setMobileSidebarOpen(false, true);
      return;
    }
    if (event.key === 'Tab' && shell.classList.contains('sidebar-open')) {
      const focusable = getSidebarFocusableElements();
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  window.addEventListener('resize', () => {
    hideSidebarTooltip();
    if (!isTabletSidebarViewport()) shell.classList.remove('sidebar-tablet-expanded');
    if (!isMobileSidebarViewport()) setMobileSidebarOpen(false);
    else if (!shell.classList.contains('sidebar-open')) setMobileSidebarOpen(false);
    updateSidebarControls();
  });
  if (isMobileSidebarViewport()) setMobileSidebarOpen(false);
  else sidebar.setAttribute('aria-hidden', 'false');
  updateSidebarControls();
}

const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  themeToggle.onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  updateThemeButton();
}
initializeSidebar();
document.getElementById('refresh-runs').onclick = () => { void loadCollection('runs'); };
document.getElementById('refresh-processes').onclick = () => { void loadLiveProcesses(); };

async function viewJobRuns(id, refresh = false) { const host = document.getElementById(`job-runs-${id}`); const button = document.getElementById(`job-runs-button-${id}`); if (!host) return; if (!refresh && !host.classList.contains('hidden')) { host.classList.add('hidden'); if (button) button.textContent = 'View backups'; return; } host.classList.remove('hidden'); if (!vaultbackJobRunPages[id]) vaultbackJobRunPages[id] = { page: 1, pageSize: 25, search: '' }; const options = vaultbackJobRunPages[id]; host.innerHTML = '<div class="hint">Loading downloadable backups…</div>'; try { const params = new URLSearchParams({ page: String(options.page), pageSize: String(options.pageSize) }); if (options.search) params.set('search', options.search); const result = await api(`/api/jobs/${encodeURIComponent(id)}/runs?${params}`); if (button) button.textContent = 'Hide backups'; const first = result.total ? ((result.page - 1) * result.pageSize) + 1 : 0; const last = Math.min(result.total, result.page * result.pageSize); host.innerHTML = `<div class="job-runs-title">Downloadable backups · ${result.total} total</div><div class="list-toolbar"><input id="job-runs-search-${id}" type="search" placeholder="Search filename" value="${esc(options.search)}" autocomplete="off" /><span class="list-summary">Showing ${first}–${last}</span></div>${result.items.length ? `<div class="job-runs-list">${result.items.map(run => `<div class="job-run-row"><div><b>${esc(run.filename)}</b><small>Completed · ${fmtDate(run.startedAt)}</small></div><span>${fmtBytes(run.sizeBytes)} <button type="button" class="small-button" onclick="downloadRunArtifact(this, '${esc(run.id)}')">Download</button></span></div>`).join('')}</div>` : '<div class="empty">No downloadable backups match this search.</div>'}<div class="pagination"><div><button class="small-button" id="job-runs-prev-${id}" ${result.page <= 1 ? 'disabled' : ''}>Previous</button><b>Page ${result.page} of ${result.pageCount}</b><button class="small-button" id="job-runs-next-${id}" ${result.page >= result.pageCount ? 'disabled' : ''}>Next</button></div></div>`; document.getElementById(`job-runs-search-${id}`).oninput = event => { clearTimeout(vaultbackSearchTimers[`job-${id}`]); vaultbackSearchTimers[`job-${id}`] = setTimeout(() => { options.search = event.target.value.trim(); options.page = 1; void viewJobRuns(id, true); }, 300); }; document.getElementById(`job-runs-prev-${id}`).onclick = () => { options.page = Math.max(1, options.page - 1); void viewJobRuns(id, true); }; document.getElementById(`job-runs-next-${id}`).onclick = () => { options.page = Math.min(result.pageCount, options.page + 1); void viewJobRuns(id, true); }; } catch (e) { host.innerHTML = `<div class="callout">Unable to load backups: ${esc(e.message)}</div>`; } }

async function exportFullConfig() { const password = $('#full-export-password').value; if (password.length < 12) { toast('Use an export password of at least 12 characters', true); return; } try { const response = await fetch('/api/settings/export/full', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': state.csrf }, body: JSON.stringify({ password }) }); if (!response.ok) { let message = 'Encrypted export failed'; try { const data = await response.json(); message = data.message || message; } catch {} throw new Error(message); } const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `vaultback-encrypted-export-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); $('#full-export-password').value = ''; toast('Encrypted migration package exported'); } catch (e) { toast(e.message, true); } }
async function importFullConfig() { const file = $('#full-import-file').files?.[0]; const password = $('#full-import-password').value; if (!file) { toast('Choose an encrypted VaultBack export package first', true); return; } if (password.length < 12) { toast('Enter the export password of at least 12 characters', true); return; } if (file.size > 60 * 1024 * 1024) { toast('The export package is too large', true); return; } try { const pkg = JSON.parse(await file.text()); const result = await api('/api/settings/import/full', { method: 'POST', body: JSON.stringify({ password, package: pkg }) }); $('#full-import-file').value = ''; $('#full-import-password').value = ''; toast(result.message || 'Import staged; restart VaultBack to activate it'); } catch (e) { toast(e.message, true); } }
function bindMigrationControls() { if (document.body.dataset.migrationBound) return; document.body.dataset.migrationBound = '1'; $('#export-full').onclick = exportFullConfig; $('#import-full').onclick = importFullConfig; }
async function restoreRunFromHistory(id) { return openRestoreModal(id); }
function closeRestoreModal() { const modal = $('#restore-modal'); if (modal) modal.remove(); document.body.classList.remove('modal-open'); }
function openRestoreModal(id) { const run = state.runs.find(item => item.id === id); if (!run) return toast('Backup run is no longer available', true); const canRename = run.databaseScope === 'selected' && Array.isArray(run.databases) && run.databases.length === 1; const root = $('#modal-root'); const connectionOptions = state.connections.map(connection => `<option value="${esc(connection.id)}" ${connection.id === run.databaseConnectionId ? 'selected' : ''}>${esc(connection.name)} · ${esc(connection.host)}:${esc(connection.port)}</option>`).join(''); root.insertAdjacentHTML('beforeend', `<section id="restore-modal" class="form-panel"><form class="form-shell" onsubmit="return false"><button type="button" class="modal-close" aria-label="Close restore dialog" onclick="closeRestoreModal()">×</button><h3>Restore backup</h3><p class="hint">Choose the destination server and whether the backup should replace its original database names or be restored under a new name.</p><div class="form-grid"><div class="field full"><label for="restore-connection">Destination database connection</label><select id="restore-connection">${connectionOptions}</select></div><div class="field full"><label for="restore-mode">Restore mode</label><select id="restore-mode"><option value="overwrite">Restore original database names (may overwrite data)</option><option value="new" ${canRename ? '' : 'disabled'}>Restore as a new database name${canRename ? '' : ' — only available for one-database backups'}</option></select></div><div id="restore-new-fields" class="field full hidden"><label for="restore-database-name">New database name</label><input id="restore-database-name" placeholder="example_restored" pattern="[A-Za-z0-9_]{1,64}" /><small class="hint">Letters, numbers, and underscores only.</small></div><div id="restore-warning" class="callout dependency-warning full"><b>Destructive action</b><br>This can overwrite the latest data in the destination database(s). Confirm that you have a recent backup and selected the correct destination.</div><label class="field full"><span><input id="restore-confirm" type="checkbox" /> I understand that existing destination data may be overwritten.</span></label></div><div class="form-actions"><button type="button" class="secondary" onclick="closeRestoreModal()">Cancel</button><button type="button" class="primary" id="restore-submit">Restore backup</button></div></form></section>`); document.body.classList.add('modal-open'); const mode = $('#restore-mode'); const fields = $('#restore-new-fields'); const warning = $('#restore-warning'); const update = () => { const renamed = mode.value === 'new'; fields.classList.toggle('hidden', !renamed); warning.innerHTML = renamed ? '<b>Check the name carefully</b><br>If the new database name already exists, restoring can overwrite it. Choose a new name or explicitly confirm the overwrite.' : '<b>Destructive action</b><br>This can overwrite the latest data in the destination database(s). Confirm that you have a recent backup and selected the correct destination.'; }; mode.onchange = update; update(); $('#restore-submit').onclick = async () => { const submit = $('#restore-submit'); const newName = $('#restore-database-name').value.trim(); if (mode.value === 'new' && !/^[A-Za-z0-9_]{1,64}$/.test(newName)) return toast('Enter a valid new database name', true); if (!$('#restore-confirm').checked) return toast('Confirm the restore warning before continuing', true); submit.disabled = true; try { const result = await api(`/api/runs/${encodeURIComponent(id)}/restore`, { method: 'POST', body: JSON.stringify({ connectionId: $('#restore-connection').value, mode: mode.value, databaseName: newName, overwriteConfirmed: true }) }); closeRestoreModal(); toast(result.message || `Restore completed on ${result.destination}`); } catch (e) { toast(e.message, true); submit.disabled = false; } }; }
function renderRuns() { collectionControls('runs', 'runs-controls', 'Search schedule, filename, or error', true); const section = $('#view-runs'); const header = section.querySelector('thead tr'); if (header && !header.querySelector('[data-verification]')) header.insertAdjacentHTML('beforeend', '<th data-verification>Verification</th><th>Action</th>'); $('#runs-table').innerHTML = state.runs.map(r => `<tr><td><b>${esc(r.jobName)}</b><br><small>${esc(r.filename || r.errorMessage || '—')}</small></td><td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td><td>${fmtDate(r.startedAt)}</td><td>${fmtBytes(r.sizeBytes)}</td><td class="checksum">${r.sha256 ? esc(r.sha256.slice(0, 16)) + '…' : '—'}</td><td>${r.verificationStatus === 'passed' ? '<span class="verified">Archive verified</span>' : esc(r.verificationStatus || '—')}</td><td>${r.status === 'success' ? `<a class="small-button" href="/api/runs/${encodeURIComponent(r.id)}/download" download>Download</a>${state.role === 'admin' ? `<button class="small-button" onclick="openRestoreModal('${r.id}')">Restore</button>` : ''}` : r.status === 'failed' ? `<button class="small-button" onclick="retryRun('${r.id}')">Retry</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No backup runs match this search.</td></tr>'; renderCollectionPagination('runs', 'runs-pagination'); }
let processModalPreviousFocus = null;

function processStatusText(item) {
  return item.status === 'running' ? 'Running' : String(item.status || 'Unknown').replace(/^./, value => value.toUpperCase());
}

function processCardMarkup(item) {
  const active = item.status === 'running';
  const logs = (item.logs || []).slice(-24);
  const id = String(item.id || 'unknown');
  return `<article class="process-card ${esc(item.status || 'unknown')}" data-process-id="${esc(id)}"><div class="process-card-head"><div><span class="process-state ${active ? 'running' : esc(item.status || 'unknown')}"><span class="process-state-dot"></span>${esc(processStatusText(item))}</span><h3>${esc(item.jobName || 'Backup process')}</h3><small>Process ${esc(id.slice(0, 8))} · Started ${esc(fmtDate(item.startedAt))}</small></div><strong class="process-stage">${esc(processStageLabels[item.stage] || item.stage || 'Processing')}</strong></div><div class="process-meta"><span>Duration <b>${processDuration(item)}</b></span><span>Updated <b>${esc(fmtDate(item.updatedAt))}</b></span></div><div class="process-log" aria-live="polite">${logs.length ? logs.map(log => `<div>${esc(log)}</div>`).join('') : '<div class="process-log-empty">Waiting for process output…</div>'}</div></article>`;
}

function renderProcessList(element) {
  if (!element) return;
  const previousLogs = new Map([...element.querySelectorAll('.process-card')].map(card => {
    const log = card.querySelector('.process-log');
    if (!log) return [card.dataset.processId, null];
    const distanceFromBottom = log.scrollHeight - log.scrollTop - log.clientHeight;
    return [card.dataset.processId, { scrollTop: log.scrollTop, followBottom: distanceFromBottom <= 32 }];
  }));
  element.innerHTML = state.processes.length
    ? state.processes.map(processCardMarkup).join('')
    : '<div class="empty process-empty">No active or recent processes. Start a scheduled backup or use Run now to see live progress here.</div>';
  element.querySelectorAll('.process-card').forEach(card => {
    const log = card.querySelector('.process-log');
    if (!log) return;
    const previous = previousLogs.get(card.dataset.processId);
    if (!previous || previous.followBottom) log.scrollTop = log.scrollHeight;
    else log.scrollTop = Math.min(previous.scrollTop, log.scrollHeight);
  });
}

function renderProcesses() {
  renderProcessList($('#processes-list'));
  renderProcessList($('#process-modal-list'));
}

function renderProcessIndicator() {
  const button = $('#process-indicator');
  if (!button) return;
  const countElement = $('#process-indicator-count');
  const popoverCount = $('#process-popover-count');
  const list = $('#process-popover-list');
  const active = state.processes.filter(item => item.status === 'running');
  const preview = (active.length ? active : state.processes).slice(0, 3);
  const count = active.length;
  const label = `${count} running process${count === 1 ? '' : 'es'}`;
  if (countElement) countElement.textContent = String(count);
  button.classList.toggle('has-active', count > 0);
  button.setAttribute('aria-label', count ? label : 'No running processes');
  button.title = count ? label : 'No running processes';
  if (popoverCount) popoverCount.textContent = count ? `${count} running` : (state.processes.length ? 'No active processes' : 'No recent activity');
  if (list) list.innerHTML = preview.length ? preview.map(item => `<div class="process-popover-item"><span class="process-popover-dot ${item.status === 'running' ? 'running' : esc(item.status || 'unknown')}"></span><div><b>${esc(item.jobName || 'Backup process')}</b><small>${esc(processStatusText(item))} · ${esc(processStageLabels[item.stage] || item.stage || 'Processing')}</small></div></div>`).join('') : '<p class="process-popover-empty">No active processes</p>';
}

function openProcessModal() {
  const root = $('#process-modal-root');
  if (!root) return;
  $('#process-indicator-wrap')?.classList.remove('process-popover-closed');
  processModalPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : $('#process-indicator');
  renderProcesses();
  root.classList.remove('hidden');
  root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('process-modal-open');
  $('#process-indicator')?.setAttribute('aria-expanded', 'true');
  $('#process-modal-close')?.focus();
}

function closeProcessModal() {
  const root = $('#process-modal-root');
  if (!root || root.classList.contains('hidden')) return;
  root.classList.add('hidden');
  root.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('process-modal-open');
  $('#process-indicator')?.setAttribute('aria-expanded', 'false');
  $('#process-indicator-wrap')?.classList.add('process-popover-closed');
  if (processModalPreviousFocus instanceof HTMLElement) processModalPreviousFocus.focus();
  processModalPreviousFocus = null;
}

function processModalFocusable() {
  const modal = $('#process-modal');
  if (!modal) return [];
  return [...modal.querySelectorAll('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(element => !element.disabled && element.getClientRects().length > 0);
}

async function loadLiveProcesses() {
  try {
    const result = await api('/api/processes');
    state.processes = result.items || [];
    renderProcesses();
    renderProcessIndicator();
    const active = state.processes.filter(item => item.status === 'running').length;
    const live = $('#process-live-status');
    const modalLive = $('#process-modal-status');
    const status = active ? `${active} active · live updates` : 'Live updates';
    if (live) live.innerHTML = `<span class="live-dot"></span> ${status}`;
    if (modalLive) modalLive.innerHTML = `<span class="live-dot"></span>${status}`;
  } catch (error) {
    renderProcessIndicator();
    const message = `<div class="callout">Unable to load live process data: ${esc(error.message)}</div>`;
    if (state.currentView === 'processes') { const list = $('#processes-list'); if (list) list.innerHTML = message; }
    const modalList = $('#process-modal-list');
    if (modalList && !$('#process-modal-root')?.classList.contains('hidden')) modalList.innerHTML = message;
  }
}

function syncLiveProcessPolling() {
  if (state.csrf) {
    if (!liveProcessTimer) liveProcessTimer = setInterval(() => void loadLiveProcesses(), 2000);
  } else if (liveProcessTimer) {
    clearInterval(liveProcessTimer);
    liveProcessTimer = null;
  }
}

function initializeProcessIndicator() {
  const actions = document.querySelector('.top-actions');
  if (actions && !$('#process-indicator')) {
    actions.insertAdjacentHTML('afterbegin', '<div class="process-indicator-wrap" id="process-indicator-wrap"><button type="button" class="process-indicator" id="process-indicator" aria-label="No running processes" aria-expanded="false" aria-controls="process-popover" title="No running processes"><span class="process-indicator-icon" aria-hidden="true">&#9673;</span><span class="process-indicator-count" id="process-indicator-count">0</span><span class="sr-only">Live processes</span></button><div class="process-popover" id="process-popover" role="region" aria-label="Live process summary"><div class="process-popover-head"><b>Live processes</b><span id="process-popover-count">No active processes</span></div><div id="process-popover-list"></div><button type="button" class="process-popover-action" id="process-popover-open">View process details</button></div></div>');
  }
  renderProcessIndicator();
  const indicatorWrap = $('#process-indicator-wrap');
  indicatorWrap?.addEventListener('pointerenter', () => indicatorWrap.classList.remove('process-popover-closed'));
  indicatorWrap?.addEventListener('focusout', () => requestAnimationFrame(() => {
    if (!indicatorWrap.contains(document.activeElement)) indicatorWrap.classList.remove('process-popover-closed');
  }));
  $('#process-indicator')?.addEventListener('click', openProcessModal);
  $('#process-modal-close')?.addEventListener('click', closeProcessModal);
  $('#process-modal-root')?.addEventListener('click', event => { if (event.target === event.currentTarget) closeProcessModal(); });
  $('#process-popover-open')?.addEventListener('click', openProcessModal);
  document.addEventListener('keydown', event => {
    const root = $('#process-modal-root');
    if (!root || root.classList.contains('hidden')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeProcessModal(); return; }
    if (event.key !== 'Tab') return;
    const focusable = processModalFocusable();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

async function loadAll() {
  await Promise.all(['connections', 'storage', 'jobs', 'runs'].map(loadCollection));
  if (state.role === 'admin') await loadCollection('users'); else state.users = [];
  updateRoleUi();
  if (state.currentView === 'sessions' && state.role !== 'admin') { window.history.replaceState({}, '', '/'); setView('not-found', { history: false }); return; }
  renderDashboard();
  if (state.currentView === 'connections') renderConnections();
  if (state.currentView === 'storage') renderStorage();
  if (state.currentView === 'jobs') renderJobs();
  if (state.currentView === 'runs') renderRuns();
  if (state.currentView === 'settings') renderSettings();
  if (state.currentView === 'sessions' && state.role === 'admin') await loadSessions();
  renderProcesses();
  await loadLiveProcesses();
  syncLiveProcessPolling();
}

initializeProcessIndicator();

// The effective Settings renderer is defined later in this legacy bundle, so
// bind the user modal controls after all renderer definitions have loaded.
if ($('#new-user')) $('#new-user').onclick = openUserModal;
if ($('#cancel-user')) $('#cancel-user').onclick = closeUserModal;
if ($('#save-user')) $('#save-user').onclick = saveUser;
if ($('#logout')) $('#logout').onclick = async () => {
  const confirmed = await appDialog({
    title: 'Sign out of VaultBack?',
    message: 'Your current session will end on this device. You can sign in again at any time.',
    confirmText: 'Sign out',
    cancelText: 'Stay signed in',
    danger: true
  });
  if (!confirmed) return;
  try {
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  } catch (e) {
    toast(e.message, true);
  }
};

// User management policy: the first account is immutable, administrator
// accounts are peer-protected, and only lower-role accounts can be managed.
var vaultbackBaseRenderSettings = function() {
  const isAdmin = state.role === 'admin';
  $('#admin-permission-note').classList.toggle('hidden', isAdmin);
  $('#new-user').classList.toggle('hidden', !isAdmin);
  $('#user-list').innerHTML = '';
  $('#capacity-list').innerHTML = state.capacity.map(item => `<div class="capacity-row"><div><b>${esc(item.name)}</b><small>${formatCapacity(item.freeBytes)} free of ${formatCapacity(item.totalBytes)}</small></div><strong class="capacity-value ${item.usedPercent >= 85 ? 'warning' : ''}">${item.usedPercent === null ? '—' : `${item.usedPercent}% used`}</strong></div>`).join('') || '<div class="empty">Capacity information is unavailable.</div>';
  const notification = state.notifications || {};
  $('#notification-enabled').checked = Boolean(notification.enabled);
  $('#notification-provider').value = notification.provider || 'discord';
  $('#notify-success').checked = Boolean(notification.events?.backup_success);
  $('#notify-failed').checked = notification.events?.backup_failed !== false;
  $('#notify-capacity').checked = notification.events?.capacity_warning !== false;
  updateNotificationFields();
  if (!document.body.dataset.settingsBound) {
    document.body.dataset.settingsBound = '1';
    $('#notification-provider').addEventListener('change', updateNotificationFields);
    $('#save-notifications').onclick = saveNotifications;
    $('#export-config').onclick = exportSafeConfig;
  }
  $('#new-user').onclick = () => openUserModal();
  $('#cancel-user').onclick = closeUserModal;
  $('#save-user').onclick = saveUser;
  collectionControls('users', 'users-controls', 'Search username or role');
  renderCollectionPagination('users', 'users-pagination');
  bindMigrationControls();
  const dependencyPanel = $('#dependency-tools-panel');
  const dependencyHints = dependencyPanel?.querySelectorAll('.hint');
  if (dependencyHints?.[0]) dependencyHints[0].textContent = 'VaultBack uses the native Node driver for connection tests and database discovery. Bundled client and dump utilities are used for backups and restores.';
  if (dependencyHints?.[1]) dependencyHints[1].textContent = 'Repair removes and replaces only the platform-specific portable tools managed by VaultBack. Operating-system installations and PATH entries are ignored.';
  bindDependencyToolsControls();
  void loadDependencyDiagnostics();
  const migration = $('#migration-panel');
  if (migration) migration.classList.toggle('hidden', !isAdmin);
};

function userManagementActions(user) {
  if (user.isPrimary) return `<span class="user-protected">Primary administrator</span>${state.isPrimary ? '<button class="small-button danger" onclick="forceLogoutEveryone()">Force logout everyone</button>' : ''}`;
  if (user.role === 'admin') return '<span class="user-protected">Administrator · peer protected</span>';
  return `<button class="small-button" onclick="editUser('${encodeURIComponent(user.id)}')">Edit</button><button class="small-button danger" onclick="deleteUser('${encodeURIComponent(user.id)}')">Delete</button><button class="small-button danger" onclick="forceLogoutUser('${encodeURIComponent(user.id)}')">Force logout</button>`;
}

function renderSettings() {
  if (typeof vaultbackBaseRenderSettings !== 'function') return;
  vaultbackBaseRenderSettings();
  if (state.role !== 'admin') return;
  const list = $('#user-list');
  if (!list) return;
  list.innerHTML = state.users.map(user => `<div class="user-row"><div><b>${esc(user.username)}</b><small>${esc(user.role)} · last login ${user.lastLoginAt ? fmtDate(user.lastLoginAt) : 'never'}</small></div><div class="user-actions">${userManagementActions(user)}</div></div>`).join('') || '<div class="empty">No user accounts match this search.</div>';
}

function openUserModal(user = null) {
  const root = document.getElementById('modal-root');
  const form = $('#user-form');
  if (!root || !form) return;
  if (form.parentElement !== root) root.appendChild(form);
  form.dataset.editId = user?.id || '';
  form.querySelector('h4').textContent = user ? 'Edit user' : 'Add user';
  form.querySelector('input[name="username"]').value = user?.username || '';
  form.querySelector('select[name="role"]').value = user?.role || 'operator';
  const password = form.querySelector('input[name="password"]');
  password.value = '';
  password.placeholder = user ? 'Leave blank to keep current password' : 'At least 12 characters';
  form.querySelector('#save-user').textContent = user ? 'Save changes' : 'Add user';
  form.classList.remove('hidden');
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => form.querySelector('input[name="username"]')?.focus());
}

function closeUserModal() {
  const form = $('#user-form');
  if (!form) return;
  form.classList.add('hidden');
  delete form.dataset.editId;
  document.body.classList.remove('modal-open');
}

function editUser(id) {
  const user = state.users.find(item => item.id === decodeURIComponent(id));
  if (!user || user.isPrimary || user.role === 'admin') {
    toast('Administrator accounts cannot be modified by another administrator', true);
    return;
  }
  openUserModal(user);
}

async function saveUser() {
  const form = $('#user-form');
  const submit = $('#save-user');
  if (!form || !submit) return;
  submit.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    const editId = form.dataset.editId;
    if (!editId && String(data.password || '').length < 12) throw new Error('Use a password of at least 12 characters');
    if (editId && data.password === '') delete data.password;
    const endpoint = editId ? `/api/auth/users/${encodeURIComponent(editId)}` : '/api/auth/users';
    await api(endpoint, { method: editId ? 'PATCH' : 'POST', body: JSON.stringify(data) });
    toast(editId ? 'User updated' : 'User added');
    form.reset();
    closeUserModal();
    await loadCollection('users');
  } catch (e) {
    toast(e.message, true);
  } finally {
    submit.disabled = false;
  }
}

async function forceLogoutUser(id) {
  const user = state.users.find(item => item.id === decodeURIComponent(id));
  if (!user || user.isPrimary || user.role === 'admin') return toast('Only operator and viewer sessions can be revoked here', true);
  const confirmed = await appDialog({ title: `Force logout ${user.username}?`, message: 'All active sessions for this user will stop working immediately.', confirmText: 'Force logout', cancelText: 'Cancel', danger: true });
  if (!confirmed) return;
  try {
    const result = await api(`/api/auth/users/${encodeURIComponent(user.id)}/logout-sessions`, { method: 'POST' });
    toast(`${result.sessionsClosed} session${result.sessionsClosed === 1 ? '' : 's'} closed`);
    await loadCollection('users');
    await loadSessions();
  } catch (e) { toast(e.message, true); }
}

async function forceLogoutLowerSessions() {
  const confirmed = await appDialog({ title: 'Force logout operators and viewers?', message: 'All active sessions belonging to operator and viewer accounts will stop working immediately.', confirmText: 'Force logout', cancelText: 'Cancel', danger: true });
  if (!confirmed) return;
  try {
    const result = await api('/api/auth/sessions/logout-lower', { method: 'POST' });
    toast(`${result.sessionsClosed} session${result.sessionsClosed === 1 ? '' : 's'} closed`);
    await loadSessions();
  } catch (e) { toast(e.message, true); }
}

async function forceLogoutEveryone() {
  if (!state.isPrimary) return toast('Only the first administrator can force logout everyone', true);
  const confirmed = await appDialog({ title: 'Force logout everyone?', message: 'Every active session, including this administrator session, will stop working immediately. You will need to sign in again.', confirmText: 'Logout everyone', cancelText: 'Cancel', danger: true });
  if (!confirmed) return;
  try {
    const result = await api('/api/auth/sessions/logout-all', { method: 'POST' });
    toast(`${result.sessionsClosed} session${result.sessionsClosed === 1 ? '' : 's'} closed`);
    setTimeout(() => location.reload(), 500);
  } catch (e) { toast(e.message, true); }
}

async function restartApplication() {
  const confirmed = await appDialog({ title: 'Restart VaultBack?', message: 'The application will briefly disconnect. Any backup currently running may be interrupted. Use this only when the service can be restarted by PM2, aaPanel, Docker, or another process manager.', confirmText: 'Restart application', cancelText: 'Cancel', danger: true });
  if (!confirmed) return;
  const button = $('#restart-app');
  if (button) button.disabled = true;
  try {
    const result = await api('/api/settings/restart', { method: 'POST' });
    toast(result.message || 'Restart requested');
    setTimeout(() => location.reload(), 1600);
  } catch (e) {
    if (button) button.disabled = false;
    toast(e.message, true);
  }
}

if ($('#new-user')) $('#new-user').onclick = () => openUserModal();
if ($('#cancel-user')) $('#cancel-user').onclick = closeUserModal;
if ($('#save-user')) $('#save-user').onclick = saveUser;
if ($('#refresh-sessions')) $('#refresh-sessions').onclick = loadSessions;
if ($('#logout-lower-sessions')) $('#logout-lower-sessions').onclick = forceLogoutLowerSessions;
if ($('#logout-all-sessions')) $('#logout-all-sessions').onclick = forceLogoutEveryone;
if ($('#restart-app')) $('#restart-app').onclick = restartApplication;

function renderSessionPagination() {
  const host = $('#sessions-pagination');
  const meta = state.sessionInfo || { page: 1, pageSize: 25, pageCount: 1, total: 0 };
  if (!host) return;
  const first = meta.total ? ((meta.page - 1) * meta.pageSize) + 1 : 0;
  const last = Math.min(meta.total, meta.page * meta.pageSize);
  host.innerHTML = `<div class="pagination"><span>Showing ${first}–${last} of ${meta.total}</span><div><button class="small-button" data-session-page="first" ${meta.page <= 1 ? 'disabled' : ''}>First</button><button class="small-button" data-session-page="prev" ${meta.page <= 1 ? 'disabled' : ''}>Previous</button><b>Page ${meta.page} of ${meta.pageCount}</b><button class="small-button" data-session-page="next" ${meta.page >= meta.pageCount ? 'disabled' : ''}>Next</button><button class="small-button" data-session-page="last" ${meta.page >= meta.pageCount ? 'disabled' : ''}>Last</button></div></div>`;
  host.querySelectorAll('button[data-session-page]').forEach(button => button.onclick = () => {
    const action = button.dataset.sessionPage;
    state.list.sessions.page = action === 'first' ? 1 : action === 'last' ? meta.pageCount : action === 'prev' ? Math.max(1, meta.page - 1) : Math.min(meta.pageCount, meta.page + 1);
    void loadSessions();
  });
}

if ($('#refresh-sessions')) $('#refresh-sessions').onclick = loadSessions;
if ($('#sessions-page-size')) $('#sessions-page-size').onchange = event => {
  state.list.sessions.pageSize = Number(event.target.value);
  state.list.sessions.page = 1;
  void loadSessions();
};

function renderApiUsage() {
  const usage = state.apiUsage || { enabled: false, items: [], total: 0, page: 1, pageSize: 25, pageCount: 1, limit: 800 };
  const note = $('#api-usage-note');
  const table = $('#api-usage-table');
  if (!table) return;
  if (note) {
    note.classList.remove('hidden');
    note.innerHTML = usage.enabled
      ? `<b>Current window</b><br>Usage resets at ${esc(fmtDate(usage.resetAt))}. This table excludes login and setup attempts.`
      : '<b>Rate limiting is disabled in development.</b><br>The table shows observed API traffic, but requests are not blocked by the production limit.';
  }
  table.innerHTML = (usage.items || []).map(item => {
    const limit = Math.max(1, Number(item.limit || usage.limit || 800));
    const percent = Math.min(100, Math.round((Number(item.requests || 0) / limit) * 100));
    return `<tr><td><b>${esc(item.ip)}</b><small>Current one-minute window</small></td><td><strong>${esc(item.requests)}</strong> / ${esc(limit)}</td><td><div class="usage-meter" aria-label="${esc(percent)} percent of limit used"><span style="width:${percent}%"></span></div><small>${esc(item.remaining)} remaining</small></td><td>${esc(fmtDate(item.resetAt))}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="empty">No API requests observed in the current window.</td></tr>';
  renderApiUsagePagination();
}

function renderApiUsagePagination() {
  const host = $('#api-usage-pagination');
  const meta = state.apiUsage || { page: 1, pageSize: 25, pageCount: 1, total: 0 };
  if (!host) return;
  const first = meta.total ? ((meta.page - 1) * meta.pageSize) + 1 : 0;
  const last = Math.min(meta.total, meta.page * meta.pageSize);
  host.innerHTML = `<div class="pagination"><span>Showing ${first}–${last} of ${meta.total}</span><div><button class="small-button" data-api-usage-page="first" ${meta.page <= 1 ? 'disabled' : ''}>First</button><button class="small-button" data-api-usage-page="prev" ${meta.page <= 1 ? 'disabled' : ''}>Previous</button><b>Page ${meta.page} of ${meta.pageCount}</b><button class="small-button" data-api-usage-page="next" ${meta.page >= meta.pageCount ? 'disabled' : ''}>Next</button><button class="small-button" data-api-usage-page="last" ${meta.page >= meta.pageCount ? 'disabled' : ''}>Last</button></div></div>`;
  host.querySelectorAll('button[data-api-usage-page]').forEach(button => button.onclick = () => {
    const action = button.dataset.apiUsagePage;
    const options = state.list.apiUsage;
    options.page = action === 'first' ? 1 : action === 'last' ? meta.pageCount : action === 'prev' ? Math.max(1, meta.page - 1) : Math.min(meta.pageCount, meta.page + 1);
    void loadSessions();
  });
}

function renderSessionsWithUsage() {
  const policy = state.sessionInfo?.rateLimit;
  const policyHost = $('#sessions-policy');
  const table = $('#sessions-table');
  const count = $('#sessions-count');
  if (!policyHost || !table) return;
  const enabled = Boolean(policy?.enabled);
  policyHost.innerHTML = `<article class="session-policy-card"><span class="kicker">ENVIRONMENT</span><strong>${esc(policy?.environment || 'development')}</strong><small>${enabled ? 'Production protections active' : 'Rate limiting disabled in development'}</small></article><article class="session-policy-card"><span class="kicker">API LIMIT</span><strong>${enabled ? `${esc(policy?.requestsPerMinute || 800)} / min` : 'Disabled'}</strong><small>Per client IP address</small></article><article class="session-policy-card"><span class="kicker">AUTH LIMIT</span><strong>${enabled ? `${esc(policy?.authenticationAttempts || 10)} / ${esc(policy?.authenticationWindowMinutes || 15)} min` : 'Disabled'}</strong><small>Login and setup attempts</small></article><article class="session-policy-card"><span class="kicker">STORAGE</span><strong>${esc(policy?.storage || 'Server memory')}</strong><small>Not persisted between restarts</small></article>`;
  const items = state.sessions || [];
  const logoutAll = $('#logout-all-sessions');
  if (logoutAll) logoutAll.classList.toggle('hidden', !state.isPrimary);
  const pageSize = $('#sessions-page-size');
  if (pageSize) pageSize.value = String(state.list.sessions.pageSize);
  if (count) count.textContent = `Active sessions · ${state.sessionInfo?.total ?? items.length}`;
  table.innerHTML = items.map(session => `<tr><td><b>${esc(session.username)}</b>${session.isCurrent ? '<small>This browser</small>' : ''}</td><td><span class="tag">${esc(session.role)}</span></td><td>${esc(fmtDate(session.createdAt))}</td><td>${esc(fmtDate(session.expiresAt))}</td><td><span class="status ${session.isCurrent ? 'success' : 'running'}">${session.isCurrent ? 'Current' : 'Open'}</span></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No open sessions.</td></tr>';
  renderSessionPagination();
  renderApiUsage();
}

var sessionsRefreshTimer = null;
var sessionsRefreshInFlight = false;

function syncSessionsRefreshPolling() {
  const active = state.currentView === 'sessions' && state.role === 'admin';
  if (!active) {
    if (sessionsRefreshTimer) clearInterval(sessionsRefreshTimer);
    sessionsRefreshTimer = null;
    return;
  }
  if (!sessionsRefreshTimer) {
    sessionsRefreshTimer = setInterval(() => {
      if (!document.hidden) void loadSessions();
    }, 2000);
  }
}

async function loadSessions() {
  if (state.role !== 'admin' || sessionsRefreshInFlight) return;
  sessionsRefreshInFlight = true;
  syncSessionsRefreshPolling();
  try {
    const sessionsOptions = state.list.sessions;
    const usageOptions = state.list.apiUsage || (state.list.apiUsage = { page: 1, pageSize: 25 });
    const sessionsQuery = new URLSearchParams({ page: String(sessionsOptions.page), pageSize: String(sessionsOptions.pageSize) });
    const usageQuery = new URLSearchParams({ page: String(usageOptions.page), pageSize: String(usageOptions.pageSize) });
    const [sessionInfo, apiUsage] = await Promise.all([api(`/api/auth/sessions?${sessionsQuery}`), api(`/api/settings/rate-limit-usage?${usageQuery}`)]);
    state.sessionInfo = sessionInfo;
    sessionsOptions.page = sessionInfo.page;
    sessionsOptions.pageSize = sessionInfo.pageSize;
    state.sessions = sessionInfo.items || [];
    state.apiUsage = apiUsage;
    usageOptions.page = apiUsage.page;
    usageOptions.pageSize = apiUsage.pageSize;
    renderSessionsWithUsage();
  } catch (e) { toast(e.message, true); }
  finally { sessionsRefreshInFlight = false; }
}

if ($('#refresh-sessions')) $('#refresh-sessions').onclick = loadSessions;
if ($('#api-usage-page-size')) $('#api-usage-page-size').onchange = event => {
  state.list.apiUsage = state.list.apiUsage || { page: 1, pageSize: 25 };
  state.list.apiUsage.pageSize = Number(event.target.value);
  state.list.apiUsage.page = 1;
  void loadSessions();
};
