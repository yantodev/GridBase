'use strict';
const fs = require('node:fs/promises'); const path = require('node:path');
const sync = require('node:fs');
const { assertSupportedPlatform, privateDirectory } = require('../packages/local-engine/private-paths');
const { assetPath } = require('./protocol.cjs');
// Electron ready must not race filesystem awaits. This synchronous pre-ready
// equivalent uses the reviewed privateDirectory ownership/mode/path rules;
// preparePaths revalidates with that helper before engine/key initialization.
function preparePathsBeforeReady(app, platform = process.platform) {
  assertSupportedPlatform(platform);
  const invalid = () => { throw Object.assign(new Error('Private application storage unavailable.'), { code: 'PRIVATE_PATH' }); };
  if (app.isReady()) invalid();
  function validate(target, privateLeaf) {
    if (typeof target !== 'string' || !path.isAbsolute(target) || path.normalize(target) !== target || target.includes('\0')) invalid();
    let current = path.parse(target).root;
    for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); const st = sync.lstatSync(current);
      const stickyRoot = st.uid === 0 && (st.mode & 0o1000);
      if (st.isSymbolicLink() || !st.isDirectory() || ![0, process.getuid()].includes(st.uid) || ((st.mode & 0o022) && !stickyRoot)) invalid();
    }
    const st = sync.lstatSync(target);
    if (privateLeaf && (st.uid !== process.getuid() || (st.mode & 0o077))) invalid();
  }
  try {
    const appData = app.getPath('appData'); validate(appData, true);
    function child(parent, name) {
      validate(parent, true); const target = path.join(parent, name);
      try { sync.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      validate(target, true); return target;
    }
    const root = child(appData, 'GridBaseDesktop'), dataDir = child(root, 'engine-data'), tempDir = child(root, 'engine-temp'), chromium = child(root, 'chromium');
    app.setPath('userData', chromium); app.setPath('sessionData', chromium);
    return { dataDir, tempDir };
  } catch { invalid(); }
}
function applicationRoot(app) { const root = app.getAppPath(); return !app.isPackaged && path.basename(root) === 'desktop' ? path.dirname(root) : root; }
async function preparePaths(app, platform = process.platform) {
  assertSupportedPlatform(platform);
  const appData = app.getPath('appData');
  // Required existing native parent. Never create shared/default appData.
  await fs.lstat(appData); await privateDirectory(appData);
  const root = await privateDirectory(path.join(appData, 'GridBaseDesktop'));
  const dataDir = await privateDirectory(path.join(root, 'engine-data'));
  const tempDir = await privateDirectory(path.join(root, 'engine-temp'));
  const chromium = await privateDirectory(path.join(root, 'chromium'));
  app.setPath('userData', chromium); app.setPath('sessionData', chromium);
  return { dataDir, tempDir };
}
function windowOptions(appRoot) {
  return { width: 1280, height: 860, minWidth: 800, minHeight: 600, show: false, title: 'GridBase',
    webPreferences: { preload: path.join(appRoot, 'desktop/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false, webviewTag: false, navigateOnDragDrop: false } };
}
function secureContents(contents) {
  for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) contents.on(event, event => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.session.setPermissionRequestHandler((webContents, permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.on('will-download', event => event.preventDefault());
  contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !assetPath(details.url) }));
}
module.exports = { preparePaths, preparePathsBeforeReady, applicationRoot, windowOptions, secureContents };
