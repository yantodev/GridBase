'use strict';
(() => {
  document.querySelector('#startup-close').addEventListener('click', async () => {
    try { await window.GridBaseTransport.close(); }
    catch { document.querySelector('#startup-state').textContent = 'GridBase could not close. Use the native window Close action. Check the database before repeating any write.'; }
  });
  window.GridBaseNative.onEngineState(({ state }) => {
    document.querySelector('#startup-state').textContent = state === 'error' || state === 'stopped' ? 'Local engine unavailable. Use the native dialog to retry startup or close GridBase. Check the database before repeating a write.' : 'Starting the private local engine…';
  });
})();
