'use strict';
(() => {
  const TYPES = {postgresql:'PostgreSQL', mysql:'MySQL', hive:'Spark Thrift / Hive'};
  function mount({api, user}) {
    const $ = id => document.querySelector('#' + id);
    const dialog = $('mcp-dialog'), app = $('app');
    const owner = user.id;
    let revision = 0, opened = false, busy = false, loaded = false;
    let connections = [], tokens = [];
    const node = (tag, className, text) => {
      const result = document.createElement(tag);
      if (className) result.className = className;
      if (text !== undefined) result.textContent = String(text);
      return result;
    };
    function clearSecret() {
      $('mcp-secret').textContent = '';
      $('mcp-secret-result').hidden = true;
      $('mcp-copy-secret').disabled = true;
    }
    function controls() {
      $('mcp-fields').disabled = busy || !loaded;
      $('mcp-create').disabled = busy || !loaded || !connections.some(c => $('mcp-scope').value === 'full_access' || c.mcpReadOnly);
      $('mcp-refresh').disabled = busy;
      for (const button of $('mcp-token-list').querySelectorAll('button')) button.disabled = busy || button.dataset.inactive === 'true';
    }
    function close() {
      opened = false; ++revision; busy = false; loaded = false;
      clearSecret(); connections = []; tokens = [];
      $('mcp-name').value = ''; $('mcp-scope').value = 'read_only'; $('mcp-expiry').value = '30';
      for (const id of ['mcp-token-list','mcp-connections','mcp-endpoint','mcp-client-values','mcp-status','mcp-account']) $(id).textContent = '';
      if (dialog.open) dialog.close();
      controls();
    }
    function current(attempt = revision) {
      if (!opened || attempt !== revision) return false;
      if (window.GridBaseSession?.user?.id !== owner || !dialog.open || dialog.hidden || app.hidden || document.visibilityState === 'hidden') {
        close(); return false;
      }
      return true;
    }
    function safeToken(token) {
      // Whitelist metadata: even a malformed list response cannot retain a raw secret.
      return {id:String(token.id || ''), name:String(token.name || ''), prefix:String(token.prefix || ''), scope:token.scope,
        createdAt:token.createdAt, expiresAt:token.expiresAt, revokedAt:token.revokedAt,
        grants:Array.isArray(token.grants) ? token.grants.map(g => ({connectionId:String(g.connectionId || ''), name:typeof g.connectionName === 'string' ? g.connectionName : '', readOnly:g.readOnly === true})) : []};
    }
    function renderConnections() {
      const root = $('mcp-connections'); root.replaceChildren();
      const readOnly = $('mcp-scope').value !== 'full_access';
      for (const connection of connections) {
        const label = node('label', 'checkbox-field');
        const input = node('input'); input.type = 'checkbox'; input.value = connection.id;
        input.disabled = readOnly && !connection.mcpReadOnly; input.checked = false;
        const text = node('span', '', connection.name);
        text.append(node('small', '', (TYPES[connection.type] || 'SQL') + ' · ' + (connection.mcpReadOnly ? 'Read-only profile ceiling' : 'Not declared MCP read-only')));
        label.append(input, text); root.append(label);
      }
      if (!connections.length) root.append(node('p', 'field-help', 'No saved connections. Save a database profile first, then refresh settings.'));
    }
    function changeScope() {
      for (const input of $('mcp-connections').querySelectorAll('input')) {
        const connection = connections.find(c => c.id === input.value);
        input.disabled = $('mcp-scope').value !== 'full_access' && !connection?.mcpReadOnly;
        if (input.disabled) input.checked = false;
      }
      controls();
    }
    const date = value => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toLocaleString() : 'Unknown';
    function renderTokens() {
      const root = $('mcp-token-list'); root.replaceChildren();
      if (!tokens.length) root.append(node('p', 'field-help', 'No account tokens. Create one with explicit connection grants.'));
      for (const token of tokens) {
        const revoked = token.revokedAt != null;
        const expired = typeof token.expiresAt !== 'number' || token.expiresAt <= Date.now();
        const row = node('article', 'mcp-token'), heading = node('div', 'mcp-token-heading');
        heading.append(node('strong', '', token.name));
        const revokeButton = node('button', 'text-button', revoked ? 'Revoked' : expired ? 'Expired' : 'Revoke');
        revokeButton.type = 'button'; revokeButton.dataset.inactive = String(revoked || expired);
        revokeButton.setAttribute('aria-label', 'Revoke ' + token.name);
        revokeButton.addEventListener('click', () => revoke(token.id));
        heading.append(revokeButton); row.append(heading, node('code', '', token.prefix));
        row.append(node('p', '', (token.scope === 'full_access' ? 'Full access (read / write)' : 'Read only') + ' · ' + (revoked ? 'Revoked ' + date(token.revokedAt) : expired ? 'Expired' : 'Active')));
        const grants = token.grants.map(grant => {
          const name = connections.find(c => c.id === grant.connectionId)?.name || grant.name || grant.connectionId + ' (unavailable profile)';
          return name + (grant.readOnly ? ' [read-only profile ceiling]' : '');
        });
        row.append(node('p', '', 'Approved: ' + (grants.join(', ') || 'No grants')));
        row.append(node('p', '', 'Created ' + date(token.createdAt) + ' · Expires ' + date(token.expiresAt)));
        root.append(row);
      }
      controls();
    }
    function accept(data) {
      connections = Array.isArray(data.connections) ? data.connections.filter(c => c && typeof c.id === 'string' && typeof c.name === 'string').map(c => ({id:c.id,name:c.name,type:c.type,mcpReadOnly:c.mcpReadOnly === true})) : [];
      tokens = Array.isArray(data.tokens) ? data.tokens.filter(t => t && typeof t.id === 'string').map(safeToken) : [];
      const endpoint = typeof data.endpoint === 'string' ? data.endpoint : '';
      $('mcp-endpoint').textContent = endpoint;
      // Connection values, not client-specific config syntax. Never interpolate a token.
      $('mcp-client-values').textContent = 'Transport: Streamable HTTP\nEndpoint: ' + endpoint + '\nAuthorization: Bearer ${GRIDBASE_MCP_TOKEN}\nToken environment variable: GRIDBASE_MCP_TOKEN';
      loaded = true; renderConnections(); renderTokens();
    }
    async function load(attempt) {
      const data = await api('/api/mcp/tokens', {cache:'no-store'});
      if (!current(attempt)) return false;
      accept(data); return true;
    }
    async function refresh() {
      if (!current() || busy) return;
      const attempt = ++revision; busy = true; controls(); clearSecret(); $('mcp-status').textContent = 'Loading account tokens…';
      try { if (await load(attempt)) $('mcp-status').textContent = ''; }
      catch (error) { if (current(attempt)) $('mcp-status').textContent = error.message; }
      finally { if (current(attempt)) { busy = false; controls(); } }
    }
    async function open() {
      close();
      if (window.GridBaseSession?.user?.id !== owner || app.hidden || document.visibilityState === 'hidden') return;
      opened = true; dialog.hidden = false; dialog.showModal();
      $('mcp-account').textContent = '@' + user.login + ' · Account settings';
      $('mcp-name').focus();
      return refresh();
    }
    async function create(event) {
      event.preventDefault();
      if (!current() || busy || !loaded) return;
      const name = $('mcp-name').value.trim(), scope = $('mcp-scope').value;
      const expiresInDays = Number($('mcp-expiry').value);
      const selected = [...$('mcp-connections').querySelectorAll('input')].filter(n => n.checked && !n.disabled).map(n => n.value);
      const eligible = new Set(connections.filter(c => scope === 'full_access' || c.mcpReadOnly).map(c => c.id));
      const connectionIds = [...new Set(selected)].filter(id => eligible.has(id));
      if (!name || name.length > 80) { $('mcp-status').textContent = 'Enter a token name (1–80 characters).'; return; }
      if (!['read_only','full_access'].includes(scope) || ![30,90,365].includes(expiresInDays)) { $('mcp-status').textContent = 'Choose a valid scope and expiry.'; return; }
      if (!connectionIds.length) { $('mcp-status').textContent = 'Select at least one eligible saved connection explicitly.'; return; }
      const attempt = ++revision; busy = true; controls(); clearSecret(); $('mcp-status').textContent = 'Creating token…';
      let result;
      try {
        result = await api('/api/mcp/tokens', {method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,scope,expiresInDays,connectionIds})});
        if (!current(attempt)) return;
        if (typeof result.secret !== 'string' || !result.secret || !result.token?.id) throw new Error('Token response was incomplete. Refresh the list before creating another token.');
        $('mcp-secret').textContent = result.secret;
        result.secret = ''; // Keep the one-time display as the only frontend reference.
        $('mcp-secret-result').hidden = false; $('mcp-copy-secret').disabled = false;
        tokens = [safeToken(result.token), ...tokens.filter(t => t.id !== result.token.id)]; renderTokens();
        $('mcp-name').value = '';
        $('mcp-status').textContent = 'Token created. Copy it now; it will not be shown again.';
        await load(attempt);
      } catch (error) {
        if (current(attempt)) $('mcp-status').textContent = error.message;
      } finally {
        if (result) result.secret = '';
        if (current(attempt)) { busy = false; controls(); }
      }
    }
    async function revoke(id) {
      if (!current() || busy || !tokens.some(t => t.id === id)) return;
      const attempt = ++revision; busy = true; clearSecret(); controls(); $('mcp-status').textContent = 'Revoking token…';
      try {
        await api('/api/mcp/tokens/' + encodeURIComponent(id), {method:'DELETE',cache:'no-store'});
        if (!current(attempt)) return;
        if (await load(attempt)) $('mcp-status').textContent = 'Token revoked.';
      } catch (error) { if (current(attempt)) $('mcp-status').textContent = error.message; }
      finally { if (current(attempt)) { busy = false; controls(); } }
    }
    async function copy(id) {
      if (!current() || !$(id).textContent) return;
      const attempt = revision;
      try {
        if (!window.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable. Select and copy the displayed value manually.');
        await window.navigator.clipboard.writeText($(id).textContent);
        if (current(attempt)) $('mcp-status').textContent = 'Copied to clipboard.';
      } catch { if (current(attempt)) $('mcp-status').textContent = 'Clipboard unavailable. Select and copy the displayed value manually.'; }
    }
    $('account-settings').addEventListener('click', open);
    $('mcp-close').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (!dialog.open) close(); });
    $('mcp-form').addEventListener('submit', create);
    $('mcp-scope').addEventListener('change', changeScope);
    $('mcp-refresh').addEventListener('click', refresh);
    $('mcp-copy-secret').addEventListener('click', () => copy('mcp-secret'));
    $('mcp-copy-endpoint').addEventListener('click', () => copy('mcp-endpoint'));
    $('mcp-copy-values').addEventListener('click', () => copy('mcp-client-values'));
    $('mcp-discard-secret').addEventListener('click', () => { ++revision; busy = false; clearSecret(); controls(); });
    $('logout').addEventListener('click', close);
    window.addEventListener('pagehide', close);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') close(); });
    // session.js conceals the shell/dialog synchronously before account reloads.
    // Observe that boundary too, so secrets are erased rather than just hidden.
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => { if (opened) current(); });
      observer.observe(app, {attributes:true,attributeFilter:['hidden']});
      observer.observe(dialog, {attributes:true,attributeFilter:['hidden','open']});
    }
    clearSecret(); controls();
  }
  window.GridBaseMcp = {mount};
})();
