'use strict';
const fs = require('node:fs/promises');
const { createHost, senderAllowed } = require('./host.cjs');
const { applicationRoot, windowOptions, secureContents } = require('./shell.cjs');
function startupMessage(error) {
  const messages = {
    WINDOWS_PRIVATE_STORAGE_UNSUPPORTED: 'Windows native storage and engine support are not yet verified. This build refuses Windows startup. Use a verified Linux installation or wait for Windows 11 native acceptance.',
    PRIVATE_PATH: 'Private application storage is unsafe or unavailable. Create a private owner-only application-data directory using your operating system, then reopen GridBase. No shared directory was repaired.',
    FALLBACK_CONSENT_REQUIRED: 'Credential storage was not authorized. Enable your OS keyring or explicitly accept the local-key fallback when prompted.',
    KEY_BACKEND_UNAVAILABLE: 'The established OS keyring is unavailable. Unlock the same keyring and reopen GridBase. Existing keys will not be replaced or downgraded.',
    KEY_MISSING: 'Existing local data has no usable credential key. Restore a complete matching backup; do not delete or regenerate the key.',
    KEY_UNAVAILABLE: 'The local credential key cannot be opened. Restore a complete matching backup or check your OS keyring. No replacement key was generated.',
    KEY_INITIALIZING: 'Credential-key initialization is incomplete or in progress. Close other GridBase instances. Preserve the data and consult recovery guidance before changing it.',
    INVALID_MANIFEST: 'The installed engine bundle is missing, damaged or incompatible. Reinstall a complete trusted GridBase distribution; startup never downloads or compiles a runtime.',
    ENGINE_EXITED: 'The local engine stopped. Check the database before repeating any write. Startup retry never repeats SQL.'
  };
  return messages[error?.code] || 'GridBase could not start its installed local engine. Check the complete runtime installation, private storage and workspace lock. No SQL will be retried automatically.';
}
function createApplication(electron, { paths, bundleDir, EngineClient, loadOrCreateKey }) {
  const { app, BrowserWindow, dialog, ipcMain } = electron;
  let window, client, launching, unsubscribe, starting = false, quitting = false, stopped = false, stopPromise, quitPromise;
  const host = createHost({ getWindow: () => window, dialog, writeFile: fs.writeFile });
  const state = value => { if (window && !window.isDestroyed?.() && !window.webContents.isDestroyed?.()) window.webContents.send('gridbase:state', { state: value }); };
  async function stop() {
    if (!stopPromise) stopPromise = (async () => {
      host.clearEngine();
      if (launching) await launching.catch(() => {});
      unsubscribe?.(); unsubscribe = null;
      const owned = client; client = null; if (owned) await owned.stop();
    })();
    return stopPromise;
  }
  function quit() {
    if (!quitPromise) { quitting = true; quitPromise = (async () => { try { await stop(); } finally { stopped = true; app.quit(); } })(); }
    return quitPromise;
  }
  ipcMain.handle('gridbase:request', (event, input) => host.request(event, input));
  ipcMain.handle('gridbase:export', (event, input) => host.saveExport(event, input));
  ipcMain.handle('gridbase:close', (event, input) => {
    if (input !== undefined || !senderAllowed(event, window, true)) return { ok: false, error: { code: 'INVALID_SENDER', message: 'This page cannot close GridBase.', uncertainOutcome: false } };
    void quit(); return { ok: true, value: null };
  });
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('before-quit', event => { if (!stopped) { event.preventDefault(); void quit(); } });
  app.on('window-all-closed', () => { void quit(); });
  async function errorDialog(error) {
    if (quitting) return;
    state('error');
    const answer = await dialog.showMessageBox(window, { type: 'error', title: 'GridBase startup', message: startupMessage(error), buttons: ['Close', 'Retry startup'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response === 1 && !quitting) await startEngine(); else await quit();
  }
  async function startEngine() {
    if (starting || quitting) return;
    starting = true; state('starting'); let key, failure;
    try {
      try { key = await loadOrCreateKey(paths.dataDir, { allowPlaintextFallback: false }); }
      catch (error) {
        if (error.code !== 'FALLBACK_CONSENT_REQUIRED') throw error;
        const consent = await dialog.showMessageBox(window, { type: 'warning', title: 'Credential storage consent',
          message: 'No secure OS keyring is available.', detail: 'You may store the local encryption key in an owner-only file on this machine. This fallback is NOT OS-keyring encryption and does not protect credentials from other programs running as your OS account. Consent is persisted only after you choose Accept. Existing encrypted keys are never downgraded. Cancel to configure a secure keyring instead.',
          buttons: ['Cancel', 'Accept local-key fallback'], defaultId: 0, cancelId: 0, noLink: true });
        if (consent.response !== 1) throw error;
        key = await loadOrCreateKey(paths.dataDir, { allowPlaintextFallback: true });
      }
      if (quitting) return;
      // A completed teardown belongs to the previous launch, never this one.
      // Reset before publishing the replacement launch so quit joins its owned
      // client even while startup is pending or eventually fails.
      stopPromise = null;
      launching = EngineClient.start({ bundleDir, dataDir: paths.dataDir, tempDir: paths.tempDir, clientKind: 'desktop', credentialKey: key }).then(owned => { client = owned; return owned; });
      await launching;
      if (quitting) return;
      host.setEngine(client);
      unsubscribe = client.onExit(() => {
        host.clearEngine(); state('stopped');
        if (!quitting) void (async () => { await window.loadURL('gridbase://app/startup.html'); await errorDialog({ code: 'ENGINE_EXITED' }); })();
      });
      await window.loadURL('gridbase://app/index.html'); state('running');
    } catch (error) { failure = error; if (client) await stop(); }
    finally { key?.fill(0); starting = false; launching = null; }
    if (failure) await errorDialog(failure);
  }
  async function start() {
    window = new BrowserWindow(windowOptions(applicationRoot(app))); secureContents(window.webContents);
    window.removeMenu?.();
    window.webContents.on('render-process-gone', () => { host.clearResults(); void quit(); });
    window.on('closed', () => { host.clearResults(); void quit(); });
    await window.loadURL('gridbase://app/startup.html'); window.show(); await startEngine();
  }
  return Object.freeze({ start, quit });
}
module.exports = { createApplication, startupMessage };
