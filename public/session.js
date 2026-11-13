'use strict';
(() => {
  const originalFetch = window.fetch.bind(window);
  let user = null, invalid = false, checking = null, generation = 0;
  let activePage = document.visibilityState === 'visible';
  const suspendedDialogs = new Map();
  function conceal() {
    document.querySelector('#app').hidden = true;
    document.querySelectorAll?.('dialog').forEach(dialog => {
      if (dialog.open && !suspendedDialogs.has(dialog)) suspendedDialogs.set(dialog, dialog.hidden);
      if (dialog.open || suspendedDialogs.has(dialog)) dialog.hidden = true;
      if (invalid) dialog.close();
    });
    if (invalid) suspendedDialogs.clear();
  }
  function requireLogin() {
    invalid = true;
    conceal();
    window.location.replace('/login?error=session_expired');
  }
  function accountChanged() {
    if (invalid) return;
    invalid = true;
    conceal();
    window.location.reload();
  }
  window.fetch = async (input, options = {}) => {
    if (invalid || !user) throw new Error('Sesi akun tidak tersedia. Muat ulang aplikasi.');
    const headers = new Headers(options.headers);
    if (typeof input === 'string' && (input.startsWith('/api/') || input === '/auth/logout')) headers.set('X-GridBase-Account', user.id);
    const response = await originalFetch(input, {...options, headers});
    if (response.status === 401) requireLogin();
    if (response.status === 409) accountChanged();
    return response;
  };
  async function verifySession(attemptGeneration) {
    conceal();
    try {
      const response = await originalFetch('/api/auth/session', {cache: 'no-store'});
      if (!response.ok) throw new Error('Session unavailable');
      const session = await response.json();
      if (attemptGeneration !== generation || !activePage || invalid) return;
      if (!session.authenticated || typeof session.user?.id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(session.user.id)) {
        requireLogin(); return;
      }
      if (invalid) return;
      if (user && user.id !== session.user.id) { accountChanged(); return; }
      if (!user) {
        user = Object.freeze({id: session.user.id, login: session.user.login});
        window.GridBaseSession = Object.freeze({user});
        const script = document.createElement('script');
        script.src = '/app.js';
        document.body.append(script);
      }
      document.querySelector('#session-user').textContent = '@' + session.user.login;
      document.querySelector('#app').hidden = false;
      for (const [dialog, hidden] of suspendedDialogs) dialog.hidden = hidden;
      suspendedDialogs.clear();
    } catch {
      if (attemptGeneration === generation && !invalid) document.querySelector('#toast').textContent = 'Sesi tidak dapat diverifikasi. Periksa koneksi lalu muat ulang.';
    }
  }
  function checkSession() {
    if (invalid || !activePage) return Promise.resolve();
    if (checking?.generation === generation) return checking.promise;
    const attempt = {generation};
    checking = attempt;
    attempt.promise = verifySession(generation).finally(() => { if (checking === attempt) checking = null; });
    return attempt.promise;
  }
  document.querySelector('#logout').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const response = await window.fetch('/auth/logout', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
      if (!response.ok && response.status !== 401) throw new Error('Logout failed');
      invalid = true;
      conceal();
      window.location.replace('/login');
    } catch {
      button.disabled = false;
      document.querySelector('#toast').textContent = 'Gagal keluar. Periksa koneksi lalu coba lagi.';
    }
  });
  function pause() { activePage = false; generation++; conceal(); }
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', () => { activePage = document.visibilityState === 'visible'; return checkSession(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { activePage = true; return checkSession(); }
    pause();
  });
  checkSession();
})();
