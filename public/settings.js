(function (root) {
  const settingsSections = [
    { id: 'general', name: 'General', detail: 'Runtime mode and application storage capacity.', admin: false },
    { id: 'notifications', name: 'Notifications', detail: 'Delivery providers, escalation events, and notification evidence.', admin: true },
    { id: 'execution', name: 'Backup execution', detail: 'Source groups, aliases, and concurrent backup limits.', admin: true },
    { id: 'cache', name: 'Cloudflare cache', detail: 'Versioned public assets and copyable Cloudflare cache rules.', admin: true },
    { id: 'maintenance', name: 'Maintenance', detail: 'Updates, database tools, exports, and application maintenance.', admin: false },
    { id: 'access', name: 'Users and access', detail: 'Team accounts, roles, and protected administrator controls.', admin: true },
    { id: 'audit', name: 'Audit log', detail: 'Recorded administrator actions and their supporting evidence.', admin: true }
  ];

  const settingsPanelGroups = {
    'environment-panel': 'general',
    'capacity-panel': 'general',
    'notification-panel': 'notifications',
    'notification-escalation-panel': 'notifications',
    'notification-deliveries-panel': 'notifications',
    'source-groups-panel': 'execution',
    'cache-settings-panel': 'cache',
    'migration-panel': 'maintenance',
    'artifact-reconcile-panel': 'maintenance',
    'dependency-tools-panel': 'maintenance',
    'update-panel': 'maintenance',
    'restart-panel': 'maintenance',
    'users-settings-panel': 'access',
    'audit-panel': 'audit'
  };

  function settingsSectionFromUrl(search, role) {
    const requested = new URLSearchParams(search).get('section') || 'general';
    const section = settingsSections.find(item => item.id === requested);
    return section && (!section.admin || role === 'admin') ? section.id : 'general';
  }

  function revealSettingsNavigationLink(workspace, selected) {
    const navigation = workspace.querySelector('.settings-navigation');
    const link = navigation?.querySelector(`[data-settings-section-link="${selected}"]`);
    if (!navigation || !link || navigation.scrollWidth <= navigation.clientWidth) return;

    const bounds = link.getBoundingClientRect();
    const viewportLeft = navigation.getBoundingClientRect().left + navigation.clientLeft;
    const viewportRight = viewportLeft + navigation.clientWidth;
    if (bounds.left < viewportLeft) navigation.scrollLeft -= viewportLeft - bounds.left;
    else if (bounds.right > viewportRight) navigation.scrollLeft += bounds.right - viewportRight;
  }

  function initializeSettingsWorkspace() {
    const view = document.getElementById('view-settings');
    if (!view || document.getElementById('settings-workspace')) return;
    const workspace = document.createElement('div');
    workspace.id = 'settings-workspace';
    workspace.className = 'settings-workspace';
    const navigation = document.createElement('nav');
    navigation.className = 'settings-navigation';
    navigation.setAttribute('aria-label', 'Settings sections');
    const content = document.createElement('div');
    content.className = 'settings-content';

    for (const section of settingsSections) {
      const link = document.createElement('a');
      link.href = `/settings?section=${encodeURIComponent(section.id)}`;
      link.dataset.settingsSectionLink = section.id;
      link.textContent = section.name;
      link.onclick = event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const url = new URL(window.location.href);
        url.pathname = '/settings';
        url.searchParams.set('section', section.id);
        url.hash = '';
        window.history.pushState({ view: 'settings', section: section.id }, '', `${url.pathname}${url.search}`);
        const selected = renderSettingsWorkspace({ focus: true });
        if (typeof window.activateSettingsSection === 'function') void window.activateSettingsSection(selected);
      };
      navigation.appendChild(link);

      const pane = document.createElement('section');
      pane.id = `settings-section-${section.id}`;
      pane.className = 'settings-section';
      pane.dataset.settingsSection = section.id;
      pane.setAttribute('aria-labelledby', `settings-heading-${section.id}`);
      pane.hidden = true;
      const heading = document.createElement('h2');
      heading.id = `settings-heading-${section.id}`;
      heading.textContent = section.name;
      heading.tabIndex = -1;
      const description = document.createElement('p');
      description.className = 'hint settings-section-description';
      description.textContent = section.detail;
      pane.append(heading, description);
      content.appendChild(pane);
    }

    workspace.append(navigation, content);
    view.appendChild(workspace);
  }

  let lastRenderedSettingsSection = '';

  function renderSettingsWorkspace(options = {}) {
    initializeSettingsWorkspace();
    const workspace = document.getElementById('settings-workspace');
    if (!workspace) return 'general';
    const role = typeof state === 'undefined' ? 'viewer' : state.role;
    const requested = new URLSearchParams(window.location.search).get('section') || 'general';
    const selected = settingsSectionFromUrl(window.location.search, role);
    if (requested !== selected && window.location.pathname.replace(/\/+$/, '') === '/settings') {
      window.history.replaceState({ view: 'settings', section: selected }, '', `/settings?section=${selected}`);
    }

    for (const [id, group] of Object.entries(settingsPanelGroups)) {
      const panel = document.getElementById(id);
      const pane = document.getElementById(`settings-section-${group}`);
      if (panel && pane && panel.parentElement !== pane) pane.appendChild(panel);
    }
    const legacyGrid = document.querySelector('#view-settings > .settings-grid');
    if (legacyGrid && !legacyGrid.children.length) legacyGrid.remove();
    document.querySelector('#view-settings > .section-jump-nav')?.remove();

    for (const section of settingsSections) {
      const allowed = !section.admin || role === 'admin';
      const pane = document.getElementById(`settings-section-${section.id}`);
      const link = workspace.querySelector(`[data-settings-section-link="${section.id}"]`);
      if (pane) pane.hidden = !allowed || section.id !== selected;
      if (link) {
        link.hidden = !allowed;
        if (allowed && section.id === selected) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    }
    if (options.focus || selected !== lastRenderedSettingsSection) revealSettingsNavigationLink(workspace, selected);
    lastRenderedSettingsSection = selected;
    if (options.focus) document.getElementById(`settings-heading-${selected}`)?.focus();
    return selected;
  }

  let cacheSettings = null;
  let cacheSettingsRequest = null;

  function showCacheStatus(message, isError = false) {
    const status = document.getElementById('cache-settings-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('hidden', !message);
    status.classList.toggle('dependency-warning', isError);
    status.setAttribute('role', isError ? 'alert' : 'status');
  }

  function renderCacheSettings(result) {
    cacheSettings = result;
    const config = result.config;
    const form = document.getElementById('asset-cache-settings-form');
    if (!form || !config) return;
    if (!form.dataset.dirty) {
      document.getElementById('cache-enabled').checked = Boolean(config.enabled);
      document.getElementById('cache-browser-ttl').value = String(config.browserMaxAgeSeconds);
      document.getElementById('cache-edge-ttl').value = String(config.edgeMaxAgeSeconds);
    }

    const assets = document.getElementById('cache-assets-list');
    if (assets) assets.innerHTML = result.assets?.length
      ? `<div class="cache-assets-table-wrap"><table class="cache-assets-table"><thead><tr><th>Asset</th><th>SHA-256</th><th>Size</th><th>Versioned path</th></tr></thead><tbody>${result.assets.map(asset => `<tr><td>${esc(asset.name)}</td><td><code>${esc(asset.sha256)}</code></td><td>${fmtBytes(asset.bytes)}</td><td><code>${esc(asset.path)}</code></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">No JavaScript or CSS assets were found.</p>';

    const rules = document.getElementById('cache-rule-list');
    if (rules) rules.innerHTML = (result.rules || []).map((rule, index) => {
      const text = [
        `Rule: ${rule.name}`,
        `When incoming requests match: ${rule.expression}`,
        `Cache eligibility: ${rule.action}`,
        ...Object.entries(rule.settings || {}).filter(([key]) => key !== 'cacheEligibility').map(([key, value]) => `${key}: ${value}`)
      ].join('\n');
      return `<li class="cache-rule"><div><b>${esc(rule.name)}</b><small>${index === 0 ? 'Create this bypass rule first.' : 'Create this rule after the bypass rule.'}</small></div><label for="cache-rule-${index}">Expression</label><textarea id="cache-rule-${index}" readonly rows="3">${esc(rule.expression)}</textarea><pre class="cache-rule-settings">${esc(text)}</pre><button class="secondary" type="button" data-copy-cache-rule="${index}">Copy rule</button></li>`;
    }).join('') || '<li class="empty">No cache rules are available.</li>';

    const instructions = document.getElementById('cache-instructions');
    if (instructions) instructions.innerHTML = (result.instructions || []).map(item => `<li>${esc(item)}</li>`).join('');
    showCacheStatus(result.cloudflareManaged === false ? 'Cloudflare is not connected. Rules are guidance for you to copy into your Cloudflare zone.' : 'Cache settings loaded.');
  }

  async function loadCacheSettings(options = {}) {
    if (typeof state === 'undefined' || state.role !== 'admin' || typeof window.api !== 'function') return;
    if (cacheSettingsRequest) return cacheSettingsRequest;
    if (cacheSettings && !options.refresh) return cacheSettings;
    showCacheStatus('Loading cache policy and current asset hashes…');
    cacheSettingsRequest = window.api('/api/settings/cache')
      .then(result => { renderCacheSettings(result); return result; })
      .catch(error => { showCacheStatus(error.message || 'Unable to load cache settings.', true); return null; })
      .finally(() => { cacheSettingsRequest = null; });
    return cacheSettingsRequest;
  }

  async function saveCacheSettings(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = document.getElementById('save-cache-settings');
    const body = {
      enabled: document.getElementById('cache-enabled').checked,
      browserMaxAgeSeconds: Number(document.getElementById('cache-browser-ttl').value),
      edgeMaxAgeSeconds: Number(document.getElementById('cache-edge-ttl').value)
    };
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const result = await window.api('/api/settings/cache', { method: 'POST', body: JSON.stringify(body) });
      form.dataset.dirty = '';
      renderCacheSettings(result);
      showCacheStatus('Cache policy saved. Versioned responses use the new origin cache headers immediately.');
      if (typeof window.toast === 'function') window.toast('Cache policy saved');
    } catch (error) {
      showCacheStatus(error.message || 'Unable to save cache settings.', true);
    } finally {
      button.disabled = false;
      button.textContent = 'Save cache policy';
    }
  }

  async function copyCacheRule(index) {
    const rule = cacheSettings?.rules?.[Number(index)];
    if (!rule) return;
    const text = [
      `Rule: ${rule.name}`,
      `When incoming requests match: ${rule.expression}`,
      `Cache eligibility: ${rule.action}`,
      ...Object.entries(rule.settings || {}).filter(([key]) => key !== 'cacheEligibility').map(([key, value]) => `${key}: ${value}`)
    ].join('\n');
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('Clipboard access is unavailable');
      }
      if (typeof window.toast === 'function') window.toast('Cloudflare rule copied');
    } catch {
      if (typeof window.toast === 'function') window.toast('Could not access the clipboard. Select and copy the rule text.', true);
    }
  }

  function initializeCacheSettings() {
    if (document.body.dataset.cacheSettingsBound) return;
    document.body.dataset.cacheSettingsBound = '1';
    const form = document.getElementById('asset-cache-settings-form');
    form?.addEventListener('input', () => { form.dataset.dirty = '1'; });
    form?.addEventListener('change', () => { form.dataset.dirty = '1'; });
    form?.addEventListener('submit', event => void saveCacheSettings(event));
    document.getElementById('refresh-cache-settings')?.addEventListener('click', () => void loadCacheSettings({ refresh: true }));
    document.getElementById('cache-rule-list')?.addEventListener('click', event => {
      const button = event.target.closest('[data-copy-cache-rule]');
      if (button) void copyCacheRule(button.dataset.copyCacheRule);
    });
  }

  function activateSettingsSection(section) {
    initializeCacheSettings();
    if (section === 'cache') void loadCacheSettings();
    if (typeof root.loadSettingsSection === 'function') void root.loadSettingsSection(section);
  }

  root.initializeSettingsWorkspace = initializeSettingsWorkspace;
  root.renderSettingsWorkspace = renderSettingsWorkspace;
  root.activateSettingsSection = activateSettingsSection;
  root.loadCacheSettings = loadCacheSettings;
  root.renderCacheSettings = renderCacheSettings;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { settingsSectionFromUrl, settingsSections, settingsPanelGroups };
  }
})(typeof window === 'undefined' ? globalThis : window);
