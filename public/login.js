'use strict';
(() => {
  const messages = {
    not_configured: 'Login GitHub belum tersedia. Hubungi administrator untuk mengaktifkannya.',
    invalid_state: 'Sesi login tidak valid atau sudah kedaluwarsa. Silakan coba lagi.',
    denied: 'Login dibatalkan di GitHub. Silakan coba lagi untuk melanjutkan.',
    not_allowed: 'Akun GitHub ini belum memiliki akses ke workspace. Hubungi administrator.',
    failed: 'Login GitHub gagal. Silakan coba lagi.',
    busy: 'Layanan login sedang sibuk. Silakan coba beberapa saat lagi.',
    session_expired: 'Sesi Anda sudah berakhir. Silakan login kembali.',
  };
  const message = document.querySelector('#login-message');
  const button = document.querySelector('#github-login');
  function show(text) { message.textContent = text; message.hidden = false; }
  const error = new URLSearchParams(window.location.search).get('error');
  if (messages[error]) show(messages[error]);
  button.addEventListener('click', () => {
    if (button.hasAttribute('href')) button.querySelector('span').textContent = 'Menghubungkan ke GitHub…';
  });
  fetch('/api/auth/session', {cache: 'no-store'}).then(async response => {
    if (!response.ok) throw new Error('Session unavailable');
    const session = await response.json();
    if (session.authenticated) { window.location.replace('/'); return; }
    if (!session.configured) {
      show(messages.not_configured);
      button.removeAttribute('href');
      button.setAttribute('aria-disabled', 'true');
    }
  }).catch(() => show('Status login tidak dapat diperiksa. Silakan muat ulang halaman atau coba masuk kembali.'));
})();
