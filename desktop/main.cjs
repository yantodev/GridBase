'use strict';
const path = require('node:path');
const { app, protocol, dialog } = require('electron');
const { createProtocolHandler, privilegedScheme } = require('./protocol.cjs');
const { preparePaths, preparePathsBeforeReady, applicationRoot } = require('./shell.cjs');
const { createApplication, startupMessage } = require('./application.cjs');
// These privileged registrations and private Chromium paths precede app ready.
protocol.registerSchemesAsPrivileged([privilegedScheme]);
(async () => {
  try {
    const paths = preparePathsBeforeReady(app);
    if (!app.requestSingleInstanceLock()) { app.quit(); return; }
    await app.whenReady();
    await preparePaths(app);
    protocol.handle('gridbase', createProtocolHandler(applicationRoot(app)));
    const application = createApplication(require('electron'), { paths,
      bundleDir: path.join(process.resourcesPath, 'gridbase-engine'),
      EngineClient: require('../packages/local-engine').EngineClient,
      loadOrCreateKey: require('./key-store.cjs').loadOrCreateKey });
    await application.start();
  } catch (error) {
    await app.whenReady();
    await dialog.showMessageBox({ type: 'error', title: 'GridBase cannot start', message: startupMessage(error), buttons: ['Close'], defaultId: 0, cancelId: 0 });
    app.quit();
  }
})();
