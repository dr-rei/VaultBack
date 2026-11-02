/* Conservative next-run estimates; provider capacity and historical samples may be absent. */
function estimateNextBackup(job, targetId, runs, health, now = Date.now()) {
  const unknown = reason => ({ status: 'unknown', reason, estimatedBytes: null });
  if (!health || health.status !== 'healthy') return unknown('Run a storage health check.');
  if (!Number.isFinite(health.freeBytes) || health.freeBytes < 0) return unknown('This provider does not report free space.');
  const checkedAt = Date.parse(health.checkedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt > 300000 || checkedAt > now) return unknown('Capacity check is older than 5 minutes.');
  const ids = job.databaseConnectionIds || [job.databaseConnectionId];
  if (!ids.length || ids.some(id => !id)) return unknown('No source selection is available.');
  const names = value => JSON.stringify([...value].sort());
  const objects = value => {
    try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return parsed && typeof parsed === 'object' ? JSON.stringify(Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b))) : null; } catch { return null; }
  };
  let bytes = 0;
  for (const id of ids) {
    const selection = job.databaseSelections?.find(item => item.connectionId === id)?.databases || job.databases || [];
    const samples = runs.filter(run => run.jobId === job.id && run.databaseConnectionId === id && run.storageTargetId === targetId && run.status === 'success' && Number.isFinite(run.sizeBytes) && run.sizeBytes > 0 && now - Date.parse(run.startedAt) >= 0 && now - Date.parse(run.startedAt) <= 30 * 86400000 && run.databaseScope === job.databaseScope && run.backupLayout === job.backupLayout && run.compression === job.compression && run.backupEncryption === job.backupEncryption && objects(run.backupObjects) !== null && objects(run.backupObjects) === objects(job.backupObjects) && (job.databaseScope === 'all' || names(run.databases || []) === names(selection)));
    if (!samples.length) return unknown('No matching successful artifact in the recent 100 runs / 30 days.');
    bytes += Math.max(...samples.map(run => run.sizeBytes));
  }
  const estimatedBytes = Math.ceil(bytes * 1.25);
  return { status: health.freeBytes >= estimatedBytes ? 'estimated-fit' : 'at-risk', estimatedBytes, freeBytes: health.freeBytes, reason: 'Largest matching artifact per source + 25% headroom; excludes retention savings and other queued writes.' };
}
if (typeof module !== 'undefined') module.exports = { estimateNextBackup };

// Grouped operations keep their own pagination and never alter artifact-history filters.
const guidedRestoreUi = { generation: 0, timer: null, run: null, opener: null };
function closeGuidedRestoreState() {
  guidedRestoreUi.generation++;
  clearTimeout(guidedRestoreUi.timer); guidedRestoreUi.timer=null; guidedRestoreUi.run=null;
  const opener=guidedRestoreUi.opener; guidedRestoreUi.opener=null;
  if(opener?.isConnected)opener.focus();
}
function bindRestoreKeyboard(modal) {
  guidedRestoreUi.opener=document.activeElement;
  modal.onkeydown=event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeRestoreModal();return;}
    if(event.key!=='Tab')return;
    const controls=[...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')].filter(control=>control.getClientRects().length>0);
    if(!controls.length){event.preventDefault();modal.focus();return;}
    const first=controls[0],last=controls[controls.length-1];
    if(event.shiftKey&&(document.activeElement===first||!modal.contains(document.activeElement))){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||!modal.contains(document.activeElement))){event.preventDefault();first.focus();}
  };
  modal.querySelector('.modal-close')?.focus();
}
async function openRestoreModal(id) {
  if(state.role!=='admin')return toast('Administrator access required',true);
  const run=state.pageData.runs.find(item=>item.id===id);
  if(!run)return toast('Backup run is no longer available',true);
  closeRestoreModal();
  const generation=guidedRestoreUi.generation; guidedRestoreUi.run=run;
  $('#modal-root').insertAdjacentHTML('beforeend',`<section id="restore-modal" class="form-panel recovery-modal" role="dialog" aria-modal="true" aria-labelledby="restore-title"><div class="form-shell"><button type="button" class="modal-close" aria-label="Close recovery dialog" onclick="closeRestoreModal()">×</button><span class="kicker">VERIFY RECOVERY FIRST</span><h3 id="restore-title">Rehearse this backup</h3><p>Restore into generated scratch databases on a dedicated recovery server, verify the restored objects, then attempt cleanup. Production data is never a rehearsal destination.</p><p class="hint">Artifact: ${esc(run.filename||run.id)} · SHA-256: ${esc(run.sha256||'Unavailable — rehearsal will refuse unverifiable data')}</p><div id="artifact-rehearsal-controls" aria-live="polite">Loading recovery servers…</div><div id="artifact-rehearsal-evidence" aria-live="polite"></div><div class="form-actions"><button class="secondary" type="button" onclick="closeRestoreModal()">Close</button><button class="secondary" type="button" id="artifact-advanced-restore">Advanced production restore…</button></div><p class="hint">A successful rehearsal is evidence for this artifact and test server, not a guarantee of production compatibility.</p></div></section>`);
  document.body.classList.add('modal-open'); bindRestoreKeyboard($('#restore-modal'));
  $('#artifact-advanced-restore').onclick=()=>{if(guidedRestoreUi.generation!==generation)return;closeRestoreModal();openAdvancedRestoreModal(id);};
  try {
    const destinations=await api('/api/recovery/connections');
    if(guidedRestoreUi.generation!==generation)return;
    state.recoveryConnections=destinations;
    const source=state.connections.find(item=>item.id===run.databaseConnectionId);
    const compatible=destinations.filter(item=>!source||item.engine===source.engine);
    const root=$('#artifact-rehearsal-controls');
    root.innerHTML=compatible.length?`<label for="artifact-recovery-connection">Dedicated recovery server</label><select id="artifact-recovery-connection">${compatible.map(item=>`<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.host)}:${Number(item.port)}</option>`).join('')}</select><div class="form-actions"><button type="button" class="primary" id="artifact-start-rehearsal">Start isolated rehearsal</button></div>`:'<p class="callout">Add a dedicated recovery server for this database engine before rehearsing. Use a separate physical database server from the backup source.</p><button type="button" class="primary" id="artifact-configure-recovery">Configure recovery server</button>';
    if(compatible.length)$('#artifact-start-rehearsal').onclick=()=>startArtifactRehearsal(id,generation);
    else $('#artifact-configure-recovery').onclick=()=>{closeRestoreModal();setView('recovery');openRecoveryConnectionModal();};
  }catch(error){if(guidedRestoreUi.generation===generation)$('#artifact-rehearsal-controls').innerHTML=`<p role="alert">Could not load recovery servers: ${esc(error.message)}</p>`;}
}
async function startArtifactRehearsal(backupRunId,generation) {
  if(guidedRestoreUi.generation!==generation)return;
  const button=$('#artifact-start-rehearsal'), recoveryConnectionId=$('#artifact-recovery-connection').value;
  button.disabled=true;
  try {
    const result=await api('/api/recovery/rehearsals',{method:'POST',body:JSON.stringify({backupRunId,recoveryConnectionId})});
    if(guidedRestoreUi.generation!==generation)return;
    $('#artifact-rehearsal-controls').innerHTML='<p class="hint">Rehearsal started. Closing this dialog stops monitoring; the server continues verification and cleanup.</p>';
    await pollArtifactRehearsal(result.runId,generation);
  }catch(error){if(guidedRestoreUi.generation===generation){toast(error.message,true);button.disabled=false;}}
}
function renderArtifactRehearsal(result) {
  const evidence=result.evidence||{};
  const stage=evidence.stage||({passed:'Verification completed',warning:'Completed with warnings',failed:'Rehearsal failed',interrupted:'Rehearsal interrupted'}[result.status])||'queued';
  $('#artifact-rehearsal-evidence').innerHTML=`<h4>Recovery evidence</h4><p><b>${esc(result.status)}</b> · ${esc(stage)}</p><dl><dt>Rehearsal ID</dt><dd>${esc(result.runId)}</dd><dt>Backup run</dt><dd>${esc(result.backupRunId)}</dd><dt>Recovery connection</dt><dd>${esc(result.recoveryConnectionId)}</dd><dt>Started</dt><dd>${esc(fmtDate(result.startedAt))}</dd><dt>Finished</dt><dd>${esc(fmtDate(result.finishedAt))}</dd></dl>${result.errorMessage?`<p class="callout" role="alert">${esc(result.errorMessage)}</p>`:''}${(evidence.cleanupWarnings||[]).map(warning=>`<p class="callout" role="alert">Cleanup warning: ${esc(warning)}</p>`).join('')}<details><summary>Artifact, object verification and scratch database evidence</summary><pre class="rehearsal-evidence-json">${esc(JSON.stringify(evidence,null,2))}</pre></details>`;
}
async function pollArtifactRehearsal(runId,generation) {
  if(guidedRestoreUi.generation!==generation)return;
  try {
    const result=await api(`/api/recovery/rehearsals/${encodeURIComponent(runId)}`);
    if(guidedRestoreUi.generation!==generation)return;
    renderArtifactRehearsal(result);
    if(['queued','running'].includes(result.status))guidedRestoreUi.timer=setTimeout(()=>void pollArtifactRehearsal(runId,generation),1500);
  }catch(error){if(guidedRestoreUi.generation===generation){$('#artifact-rehearsal-evidence').innerHTML=`<p role="alert">Monitoring interrupted: ${esc(error.message)}. Rehearsal ${esc(runId)} may still be running.</p><button type="button" class="secondary" id="artifact-resume-monitoring">Refresh evidence</button>`;$('#artifact-resume-monitoring').onclick=()=>pollArtifactRehearsal(runId,generation);}}
}

const executionUi = { page: 1, status: '', items: [], protection: [], detail: null, error: '', loaded: false, active: [], activeRequest: 0, activeError: '', selectedId: null, detailGeneration: 0, detailRequest: 0, listRequest: 0, listQuery: '' };
function executionName(id, collection) { return state[collection].find(item => item.id === id)?.name || id; }
function executionButton(label, action, id) { return `<button type="button" class="small-button" data-execution-action="${action}" data-id="${esc(id)}">${label}</button>`; }
async function loadExecutions() {
  const root = document.getElementById('execution-list');
  const query = new URLSearchParams({page:executionUi.page,pageSize:15,status:executionUi.status}).toString();
  const request = ++executionUi.listRequest;
  const current = () => request === executionUi.listRequest && query === new URLSearchParams({page:executionUi.page,pageSize:15,status:executionUi.status}).toString();
  if (query !== executionUi.listQuery) { executionUi.items = []; executionUi.loaded = false; executionUi.error = ''; executionUi.listQuery = query; renderExecutions(); }
  root?.setAttribute('aria-busy', 'true');
  try {
    const result = await api(`/api/executions?${query}`);
    if (!current()) return;
    executionUi.items = result.items || []; executionUi.pageCount = result.pageCount || 1;
    executionUi.error = ''; executionUi.loaded = true;
  } catch (error) { if (current()) executionUi.error = error.message; }
  finally { if (current()) { root?.removeAttribute('aria-busy'); renderExecutions(); } }
}
function renderExecutions() {
  const root = document.getElementById('execution-list'); if (!root) return;
  root.innerHTML = executionUi.error ? `<p class="callout" role="alert">${esc(executionUi.error)}</p>` : executionUi.items.map(item => `<div class="operations-row"><div><b>${esc(executionName(item.jobId,'jobs'))}</b><small>${esc(item.trigger)} · Queued ${esc(fmtDate(item.queuedAt))} · ${item.pairs.length} source/destination pairs</small><small>${esc(item.status.replaceAll('_',' '))}${item.parentExecutionId ? ' · Retry execution' : ''}</small></div>${executionButton('Inspect','inspect',item.id)}</div>`).join('') || `<p class="empty">${executionUi.loaded ? 'No executions match this status.' : 'Loading executions…'}</p>`;
  const page = document.getElementById('execution-page'); if (page) page.textContent = `Page ${executionUi.page} of ${executionUi.pageCount || 1}`;
  const previous = document.getElementById('execution-prev'); if (previous) previous.disabled = executionUi.page <= 1;
  const next = document.getElementById('execution-next'); if (next) next.disabled = executionUi.page >= (executionUi.pageCount || 1);
}
function currentExecutionDetail(id, generation, request) {
  return executionUi.selectedId === id && executionUi.detailGeneration === generation && (request === undefined || executionUi.detailRequest === request);
}
function closeExecutionDetail() {
  executionUi.selectedId = null; executionUi.detail = null;
  executionUi.detailGeneration++; executionUi.detailRequest++;
  document.getElementById('execution-detail').classList.add('hidden');
  document.getElementById('execution-refresh')?.focus();
}
async function inspectExecution(id) {
  const generation = ++executionUi.detailGeneration, request = ++executionUi.detailRequest;
  executionUi.selectedId = id; executionUi.detail = null;
  const root = document.getElementById('execution-detail'); root.classList.remove('hidden'); root.innerHTML = '<p role="status">Loading execution…</p>'; root.focus();
  try {
    const result = await api(`/api/executions/${encodeURIComponent(id)}`);
    if (!currentExecutionDetail(id,generation,request)) return;
    executionUi.detail = result; renderExecutionDetail();
  } catch (error) { if(currentExecutionDetail(id,generation,request)) root.innerHTML = `<p class="callout" role="alert">${esc(error.message)}</p>`; }
}
function renderExecutionDetail() {
  const item = executionUi.detail; if (!item) return;
  const terminal = !['queued','running','retrying','cancel_requested'].includes(item.status);
  const warnings = values => values?.length ? `<p class="callout dependency-warning">Cleanup warning: ${values.map(esc).join('; ')}</p>` : '';
  const admin = state.role === 'admin';
  document.getElementById('execution-detail').innerHTML = `<div class="panel-head"><div><span class="kicker">EXECUTION DETAIL</span><h3>${esc(executionName(item.jobId,'jobs'))}</h3><small>${esc(item.id)} · ${esc(item.status.replaceAll('_',' '))}</small></div><button type="button" class="small-button" data-execution-action="close">Close</button></div>${item.parentExecutionId ? executionButton('Inspect original execution','inspect',item.parentExecutionId) : ''}${executionUi.items.filter(child=>child.parentExecutionId===item.id).map(child=>executionButton('Inspect retry','inspect',child.id)).join('')}${warnings(item.cleanupWarnings)}<div class="execution-pairs">${item.pairs.map(pair=>`<article class="execution-pair"><div class="operations-row"><label><input type="checkbox" class="execution-pair-choice" value="${esc(pair.id)}" ${!terminal||!admin?'disabled':''}> <b>${esc(executionName(pair.connectionId,'connections'))} → ${esc(executionName(pair.storageTargetId,'storage'))}</b></label><span class="tag">${pair.required?'Required':'Optional'}</span></div><p>${esc(pair.status.replaceAll('_',' '))}${pair.queuePosition ? ` · Queue position ${Number(pair.queuePosition)}` : ''}${pair.waitReason ? ` · ${esc(pair.waitReason)}` : ''}</p>${pair.attempts.map(attempt=>`<div class="execution-attempt"><b>Attempt ${Number(attempt.attemptNumber)} · ${esc(attempt.status)}</b><small>${esc(fmtDate(attempt.startedAt))} → ${esc(fmtDate(attempt.finishedAt))}</small>${attempt.failedStage?`<p>Failed stage: ${esc(attempt.failedStage)}</p>`:''}${attempt.error?`<p class="status failed">${esc(attempt.error)}</p>`:''}${attempt.runId&&attempt.status==='success'?`<a class="small-button" href="/api/runs/${encodeURIComponent(attempt.runId)}/download" download>Download artifact</a> <button type="button" class="small-button" data-execution-action="report" data-id="${esc(attempt.runId)}">Verification report</button>`:''}${warnings(attempt.cleanupWarnings)}</div>`).join('')||'<small>No attempts yet.</small>'}${warnings(pair.cleanupWarnings)}</article>`).join('')}</div><div class="card-actions">${admin && terminal ? executionButton('Retry failed pairs','retry-failed',item.id)+executionButton('Retry selected pairs','retry-selected',item.id)+executionButton('Retry all pairs','retry-all',item.id) : ''}${admin && item.status==='queued' ? executionButton('Move ahead','priority',item.id)+executionButton('Cancel queued execution','cancel',item.id) : ''}${admin && ['running','retrying'].includes(item.status) ? executionButton('Stop execution…','stop',item.id) : ''}</div>${!admin?'<p class="hint">Administrator access is required to retry, reprioritize, or cancel executions.</p>':''}`;
}
async function executionAction(action, id) {
  if(action==='close') return closeExecutionDetail();
  if(action==='overview-inspect'){setView('runs');return inspectExecution(id);}
  if(action==='inspect') return inspectExecution(id);
  if(action==='report') return showVerificationReport(id);
  if(state.role!=='admin') return toast('Administrator access required',true);
  const item=executionUi.detail; if(!item||item.id!==id)return;
  const generation=executionUi.detailGeneration;
  try {
    let endpoint=action==='priority'?'priority':'cancel', body={stopRunningConfirmed:false};
    if(action.startsWith('retry-')) {
      let pairs=item.pairs;
      if(action==='retry-failed') pairs=pairs.filter(pair=>['failed','interrupted','cancelled','not_started'].includes(pair.status));
      if(action==='retry-selected') {const selected=new Set([...document.querySelectorAll('.execution-pair-choice:checked')].map(input=>input.value));pairs=pairs.filter(pair=>selected.has(pair.id));}
      if(!pairs.length)return toast('Select at least one eligible source/destination pair',true);
      endpoint='retries';body={pairs:pairs.map(({connectionId,storageTargetId})=>({connectionId,storageTargetId}))};
    }
    if(action==='stop') {if(!await appDialog({title:'Stop this running execution?',message:'Running database processes will be stopped. Incomplete artifacts may require cleanup; warnings remain in the execution evidence.',confirmText:'Stop execution',cancelText:'Keep running',danger:true}))return;body.stopRunningConfirmed=true;}
    if(action==='retry-all'&&!await appDialog({title:'Run every pair again?',message:'This creates new backups for successful pairs as well as failed pairs. Existing artifacts and the original execution remain in history.',confirmText:'Queue all pairs',cancelText:'Cancel'}))return;
    if(!currentExecutionDetail(id,generation))return;
    const result=await api(`/api/executions/${encodeURIComponent(id)}/${endpoint}`,{method:'POST',body:JSON.stringify(body)});
    toast(endpoint==='retries'?'Retry queued':endpoint==='priority'?'Queue priority updated':action==='stop'?'Stop requested':'Queued execution cancelled');
    await loadExecutions(); if(currentExecutionDetail(id,generation)) await inspectExecution(result.id);
  }catch(error){toast(error.message,true);}
}
async function loadProtection() {
  try {const result=await api('/api/protection');executionUi.protection=Array.isArray(result)?result:result.items||[];renderProtection();} catch(error){const root=document.getElementById('protection-list');if(root)root.innerHTML=`<p role="alert">${esc(error.message)}</p>`;}
}
function renderProtection() {
  const root=document.getElementById('protection-list');if(!root)return;
  root.innerHTML=executionUi.protection.map(item=>`<div class="operations-row"><div><b>${esc(executionName(item.jobId,'jobs'))} · ${esc(executionName(item.connectionId,'connections'))} → ${esc(executionName(item.storageTargetId,'storage'))}</b><small>${item.required?'Required':'Optional'} · ${esc(item.evidence.clockRollback?'Clock unknown':item.freshnessStatus==='unknown'?'Unproven':item.freshnessStatus)} · Start: ${esc(item.missedStartStatus)} · Duration: ${esc(item.longRunningStatus)}</small><small>${esc(item.evidence.reason)}${item.latestVerifiedAt?` · Verified ${esc(fmtDate(item.latestVerifiedAt))}`:''}</small></div></div>`).join('')||'<p class="empty">No schedule protection assessments.</p>';
}
function initializeExecutionUi() {
  document.addEventListener('click',event=>{const button=event.target.closest('[data-execution-action]');if(button)void withButtonBusy(button,()=>executionAction(button.dataset.executionAction,button.dataset.id),'Working…');});
  document.getElementById('execution-status')?.addEventListener('change',event=>{executionUi.status=event.target.value;executionUi.page=1;void loadExecutions();});
  document.getElementById('execution-refresh')?.addEventListener('click',()=>void loadExecutions());
  document.getElementById('execution-prev')?.addEventListener('click',()=>{executionUi.page--;void loadExecutions();});
  document.getElementById('execution-next')?.addEventListener('click',()=>{executionUi.page++;void loadExecutions();});
}
function renderOverviewExecutionQueue(root) {
  if(executionUi.activeError)root.insertAdjacentHTML('afterbegin',`<p class="callout" role="status">Execution queue could not be refreshed. ${executionUi.active.length?'Showing last known queue.':'Queue state is unknown.'}</p>`);
  const active=executionUi.active.filter(item=>['queued','running','retrying','cancel_requested'].includes(item.status));
  if(active.length)root.insertAdjacentHTML('afterbegin',active.slice(0,5).map(item=>`<div class="operations-row"><div><b>${esc(executionName(item.jobId,'jobs'))}</b><small>${esc(item.status)} · ${item.pairs.filter(pair=>pair.status==='queued').length} pairs waiting${item.pairs.find(pair=>pair.waitReason)?.waitReason ? ' · '+esc(item.pairs.find(pair=>pair.waitReason).waitReason) : ''}</small></div><button class="small-button" data-execution-action="overview-inspect" data-id="${esc(item.id)}">Inspect</button></div>`).join(''));
}
async function loadSourceGroups() {
  if(state.role!=='admin')return;
  let root=document.getElementById('source-groups-panel');
  if(!root){root=document.createElement('section');root.id='source-groups-panel';root.className='panel admin-only-setting';document.getElementById('view-settings').appendChild(root);}
  if(state.currentView==='settings')window.renderSettingsWorkspace?.();
  try {
    const result=await api('/api/source-groups');
    state.sourceGroupsLoaded=true;
    if(state.currentView==='settings')window.renderSettingsWorkspace?.();
    const groups=Array.isArray(result.items)?result.items:[];
    const connections=Array.isArray(state.connections)?state.connections:[];
    const aliasesMarkup=(group,isAutomatic)=>connections.length
      ? `<div class="execution-alias-list">${connections.map(connection=>`<label class="execution-alias-option"><input type="checkbox" name="connectionIds" value="${esc(connection.id)}" ${(Array.isArray(group.connectionIds)?group.connectionIds:[]).includes(connection.id)?'checked':''} ${isAutomatic?'disabled':''}><span>${esc(connection.name)}</span></label>`).join('')}</div>`
      : '<p class="execution-empty-aliases">No database connections are available yet. Add a connection before assigning aliases to this group.</p>';
    const groupMarkup=groups.map((group,index)=>{
      const isAutomatic=String(group.id||'').startsWith('host:');
      const effective=Number(group.effectiveConcurrency||group.concurrency||1);
      return `<form class="execution-group-form" data-group-index="${index}">
        <div class="execution-group-heading">
          <div><span class="execution-group-index">SOURCE GROUP ${index+1}</span><p class="hint">Aliases in the same source group share this concurrency cap.</p></div>
          <span class="execution-effective-limit"><strong>${Number.isFinite(effective)?effective:1}</strong><span>effective pairs</span></span>
        </div>
        <div class="execution-group-fields">
          <label class="execution-field">Group name<input name="name" value="${esc(group.name)}" autocomplete="off" required></label>
          <label class="execution-field">Maximum concurrent pairs<span class="execution-field-hint">Per source · 1 to 8</span><input name="concurrency" type="number" min="1" max="8" step="1" value="${Number(group.concurrency||1)}" required></label>
        </div>
        <fieldset class="execution-aliases" aria-describedby="execution-alias-help-${index}">
          <legend>Connection aliases${isAutomatic?' <span class="execution-readonly-tag">Automatic</span>':''}</legend>
          <p class="hint" id="execution-alias-help-${index}">${isAutomatic?'Aliases are grouped automatically by host and cannot be changed here.':'Select every connection alias that reaches this physical source.'}</p>
          ${aliasesMarkup(group,isAutomatic)}
        </fieldset>
        <p class="execution-form-feedback" role="status" hidden></p>
        <div class="execution-group-actions"><button class="secondary" type="submit">Save source group</button></div>
      </form>`;
    }).join('');
    root.innerHTML=`
      <div class="execution-panel-heading">
        <div><span class="kicker">EXECUTION POLICY</span><h3>Concurrency limits</h3></div>
        <p class="hint">Control how many connection and storage pairs may run at once. Work already in progress keeps its current allocation.</p>
      </div>
      ${result.dispatchError?`<p class="callout" role="alert">${esc(result.dispatchError)}</p>`:''}
      <section class="execution-global-limit" aria-labelledby="execution-global-heading">
        <div><h4 id="execution-global-heading">Global limit</h4><p class="hint" id="execution-global-help">Maximum active backup pairs across all sources and storage targets.</p></div>
        <div class="execution-global-controls">
          <label class="execution-field" for="global-concurrency">Concurrent pairs<input id="global-concurrency" type="number" min="1" max="32" step="1" value="${Number(result.globalConcurrency||4)}" aria-describedby="execution-global-help" required></label>
          <button class="secondary" type="button" id="save-global-concurrency">Save global limit</button>
        </div>
        <p class="execution-form-feedback" id="global-concurrency-feedback" role="status" hidden></p>
      </section>
      <section id="source-group-list" aria-labelledby="execution-groups-heading">
        <div class="execution-section-heading"><div><h4 id="execution-groups-heading">Source groups</h4><p class="hint">Group aliases that connect to the same physical database server.</p></div><span class="execution-group-count">${groups.length} ${groups.length===1?'group':'groups'}</span></div>
        ${groups.length?`<div class="execution-group-list">${groupMarkup}</div>`:'<div class="execution-empty-state"><strong>No source groups configured</strong><p>Create a group to apply a per-source concurrency cap. You can assign connection aliases now or add them later.</p></div>'}
      </section>
      <section class="execution-create-panel" aria-labelledby="execution-create-heading">
        <div class="execution-section-heading"><div><h4 id="execution-create-heading">Add a source group</h4><p class="hint">Give it a clear name, set its pair limit, then assign the connection aliases for that server.</p></div></div>
        <form class="execution-group-form execution-group-form--create" data-group-index="-1">
          <div class="execution-group-fields">
            <label class="execution-field">Group name<input name="name" placeholder="For example, production-primary" autocomplete="off" required></label>
            <label class="execution-field">Maximum concurrent pairs<span class="execution-field-hint">Per source · 1 to 8</span><input name="concurrency" type="number" min="1" max="8" step="1" value="1" required></label>
          </div>
          <fieldset class="execution-aliases" aria-describedby="execution-alias-help-new">
            <legend>Connection aliases</legend>
            <p class="hint" id="execution-alias-help-new">Select every configured connection that reaches this physical source.</p>
            ${aliasesMarkup({connectionIds:[]},false)}
          </fieldset>
          <p class="execution-form-feedback" role="status" hidden></p>
          <div class="execution-group-actions"><button class="primary" type="submit">Create source group</button></div>
        </form>
      </section>`;
    document.getElementById('save-global-concurrency').onclick=async()=>{
      const button=document.getElementById('save-global-concurrency');
      const input=document.getElementById('global-concurrency');
      const feedback=document.getElementById('global-concurrency-feedback');
      if(!input.reportValidity()){input.focus();return;}
      button.disabled=true;
      button.textContent='Saving…';
      feedback.hidden=true;
      try {
        await api('/api/source-groups',{method:'POST',body:JSON.stringify({globalConcurrency:Number(input.value)})});
        toast('Global limit saved');
        await loadSourceGroups();
      } catch(error) {
        feedback.textContent=error.message||'Could not save the global limit. Check the value and try again.';
        feedback.hidden=false;
        feedback.setAttribute('role','alert');
        toast(feedback.textContent,true);
      } finally {
        if(button.isConnected){button.disabled=false;button.textContent='Save global limit';}
      }
    };
    root.querySelectorAll('.execution-group-form').forEach(form=>form.onsubmit=async event=>{
      event.preventDefault();
      const group=groups[Number(form.dataset.groupIndex)]||{};
      const name=form.elements.namedItem('name');
      const concurrency=form.elements.namedItem('concurrency');
      const button=form.querySelector('button[type="submit"]');
      const feedback=form.querySelector('.execution-form-feedback');
      if(!form.reportValidity()){form.querySelector(':invalid')?.focus();return;}
      button.disabled=true;
      button.textContent=form.dataset.groupIndex==='-1'?'Creating…':'Saving…';
      feedback.hidden=true;
      try {
        await api('/api/source-groups',{method:'POST',body:JSON.stringify({id:group.id,name:name.value,concurrency:Number(concurrency.value),connectionIds:group.id?.startsWith('host:')?group.connectionIds:[...form.querySelectorAll('[name=connectionIds]:checked')].map(input=>input.value)})});
        toast(form.dataset.groupIndex==='-1'?'Source group created':'Source group saved');
        await loadSourceGroups();
      } catch(error) {
        feedback.textContent=error.message||'Could not save this source group. Check the fields and try again.';
        feedback.hidden=false;
        feedback.setAttribute('role','alert');
        toast(feedback.textContent,true);
      } finally {
        if(button.isConnected){button.disabled=false;button.textContent=form.dataset.groupIndex==='-1'?'Create source group':'Save source group';}
      }
    });
  }catch(error){
    root.innerHTML=`<div class="execution-load-error"><div><h3>Execution settings unavailable</h3><p role="alert">${esc(error.message||'Could not load concurrency settings.')}</p></div><button class="secondary" type="button" id="retry-source-groups">Try again</button></div>`;
    document.getElementById('retry-source-groups')?.addEventListener('click',()=>void loadSourceGroups());
  }
}
function renderNotificationDeliveries(result) {
  if(state.role!=='admin'||!result)return;
  let root=document.getElementById('notification-deliveries-panel');if(!root){root=document.createElement('section');root.id='notification-deliveries-panel';root.className='panel admin-only-setting';document.getElementById('view-settings').appendChild(root);}
  root.innerHTML=`<div class="panel-head"><div><span class="kicker">DELIVERY EVIDENCE</span><h3>Notification deliveries</h3></div></div>${result.lastPollError?`<p class="callout" role="alert">${esc(result.lastPollError)}</p>`:''}${(result.items||[]).map(item=>`<div class="operations-row"><div><b>${esc(item.eventType||item.event_type||item.kind||item.type||'Notification')}</b><small>${esc(item.status)} · ${Number(item.attempts||0)} attempts · ${esc(item.createdAt||item.created_at||'')}</small>${item.lastError||item.last_error?`<small role="alert">${esc(item.lastError||item.last_error)}</small>`:''}</div></div>`).join('')||'<p class="empty">No notification deliveries yet.</p>'}`;
  if(state.currentView==='settings')window.renderSettingsWorkspace?.();
}

async function loadNotificationDeliveries() {
  if(state.role!=='admin')return;
  try{const result=await api('/api/notification-deliveries');state.notificationDeliveries=result;renderNotificationDeliveries(result);}
  catch(error){const result={items:[],lastPollError:error.message};state.notificationDeliveries=result;renderNotificationDeliveries(result);}
}

async function loadActiveExecutions() {
  const request=++executionUi.activeRequest;
  try {const results=await Promise.all(['queued','running','retrying','cancel_requested'].map(status=>api(`/api/executions?${new URLSearchParams({status,pageSize:100})}`)));if(request!==executionUi.activeRequest)return;executionUi.active=results.flatMap(result=>result.items||[]);executionUi.activeError='';renderOverviewOperations();}catch(error){if(request!==executionUi.activeRequest)return;executionUi.activeError=error.message;renderOverviewOperations();}
}
async function refreshExecutionDetail() {
  if(!executionUi.detail || !executionUi.selectedId)return;
  const selectedId=executionUi.selectedId, generation=executionUi.detailGeneration, request=++executionUi.detailRequest;
  const root=document.getElementById('execution-detail');
  try {
    const result=await api(`/api/executions/${encodeURIComponent(selectedId)}`);
    if(!currentExecutionDetail(selectedId,generation,request))return;
    // Capture interaction state at response time so changes made while waiting survive.
    const selected=new Set([...root.querySelectorAll('.execution-pair-choice:checked')].map(input=>input.value));
    const focused=root.contains(document.activeElement)?document.activeElement:null;
    const action=focused?.dataset.executionAction,id=focused?.dataset.id,value=focused?.value;
    executionUi.detail=result;renderExecutionDetail();
    root.querySelectorAll('.execution-pair-choice').forEach(input=>{input.checked=selected.has(input.value);if(focused&&value===input.value)input.focus();});
    if(action)[...root.querySelectorAll('[data-execution-action]')].find(button=>button.dataset.executionAction===action&&button.dataset.id===id)?.focus();
  }catch(error){if(currentExecutionDetail(selectedId,generation,request))toast(error.message,true);}
}
