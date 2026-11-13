'use strict';
(() => {
  const originalFetch = window.fetch.bind(window);
  function requireLogin() {
    document.querySelector('#app').hidden = true;
    window.location.replace('/login?error=session_expired');
  }
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (response.status === 401) requireLogin();
    return response;
  };
  async function checkSession() {
    try {
      const response = await originalFetch('/api/auth/session', {cache: 'no-store'});
      if (!response.ok) return;
      const session = await response.json();
      if (!session.authenticated) { requireLogin(); return; }
      document.querySelector('#session-user').textContent = '@' + session.user.login;
    } catch { /* The workbench reports network errors through its connection status. */ }
  }
  document.querySelector('#logout').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const response = await originalFetch('/auth/logout', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
      if (!response.ok && response.status !== 401) throw new Error('Logout failed');
      document.querySelector('#app').hidden = true;
      window.location.replace('/login');
    } catch {
      button.disabled = false;
      document.querySelector('#toast').textContent = 'Gagal keluar. Periksa koneksi lalu coba lagi.';
    }
  });
  window.addEventListener('pageshow', checkSession);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkSession(); });
  checkSession();
})();
