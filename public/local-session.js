'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const transport = window.GridBaseTransport, bridge = window.GridBaseNative;
  let loaded = false, checking = false, invalid = false;
  function conceal() {
    $('#app').hidden = true;
    document.querySelectorAll('dialog').forEach(dialog => { dialog.hidden = true; if (dialog.open) dialog.close(); });
    const password = $('#connection-password'); if (password) password.value = '';
    const jdbc = $('#connection-jdbc-url'); if (jdbc) jdbc.value = '';
    const secret = $('#mcp-secret'); if (secret) secret.textContent = '';
  }
  function error() {
    conceal(); $('#local-session-panel').hidden = false;
    $('#local-session-status').textContent = 'The local session could not be verified. Check the native startup dialog. No SQL was retried; check the database before repeating a write.';
  }
  async function verify() {
    if (checking || invalid) return; checking = true; conceal();
    try {
      if (!transport?.native) throw new Error();
      const response = await transport.request('/api/auth/session'); if (!response.ok) throw new Error();
      const session = await response.json(); if (invalid) return;
      if (session.authenticated !== true || session.mode !== 'local' || session.user?.provider !== 'local' || session.user.login !== 'Local' ||
        typeof session.user.id !== 'string' || !/^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(session.user.id) ||
        session.capabilities?.auditAdmin !== false || typeof session.capabilities?.mcpEnabled !== 'boolean') throw new Error();
      if (loaded && window.GridBaseSession.user.id !== session.user.id) { invalid = true; throw new Error(); }
      if (!loaded) {
        const user = Object.freeze({ id: session.user.id, login: 'Local', provider: 'local' });
        const capabilities = Object.freeze({ auditAdmin: false, mcpEnabled: session.capabilities.mcpEnabled });
        Object.defineProperty(window, 'GridBaseSession', { value: Object.freeze({ mode: 'local', user, capabilities }), writable: false, configurable: false });
        loaded = true; const script = document.createElement('script'); script.src = '/app.js'; document.body.append(script);
      }
      $('#session-user').textContent = 'Local'; $('#session-user').setAttribute('aria-label', 'Local profile');
      $('#logout').textContent = 'Close'; $('#local-session-panel').hidden = true; $('#app').hidden = false;
      const footer = $('.sidebar-footer'); if (footer) footer.textContent = 'SQL drafts saved in this local profile. Query results stay in memory.';
      document.querySelectorAll('dialog').forEach(dialog => { dialog.hidden = false; });
    } catch { error(); } finally { checking = false; }
  }
  $('#local-session-retry').addEventListener('click', verify);
  async function close() {
    invalid = true; conceal();
    try { await transport.close(); } catch { error(); }
  }
  $('#local-session-close').addEventListener('click', close);
  $('#logout').addEventListener('click', close);
  if (transport?.native) bridge.onEngineState(({ state }) => { if (state === 'error' || state === 'stopped') { invalid = true; error(); } });
  verify();
})();
