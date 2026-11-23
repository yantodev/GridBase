'use strict';
const { spawn } = require('node:child_process'); const path = require('node:path');
const { isMainThread } = require('node:worker_threads');
const { loadManifest } = require('./manifest');
const { privateDirectory, assertSupportedPlatform } = require('./private-paths');
const { failure } = require('./errors');
const { EngineClient, startOwnedEngine } = require('./owned-engine-client');
const START_TIMEOUT = 30000, STOP_TIMEOUT = 5000;
function inside(parent, child) { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
function scrubEnvironment(dataDir, tempDir) {
  // Fixed native-host environment. Nothing from workspace Java, proxy, preload,
  // plugin or Node injection settings enters the owned subprocess.
  if (process.platform === 'linux') return { HOME: dataDir, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: tempDir };
  const env = { TEMP: tempDir, TMP: tempDir };
  for (const key of ['SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
EngineClient.start = async function start(options) {
  let copiedKey;
  try {
    if (!isMainThread) throw failure('START_FAILED');
    if (!options || Object.keys(options).sort().join(',') !== ['bundleDir','dataDir','tempDir','clientKind','credentialKey'].sort().join(',') || !Buffer.isBuffer(options.credentialKey) || options.credentialKey.length !== 32 || !['desktop','vscode'].includes(options.clientKind)) throw failure('START_FAILED');
    assertSupportedPlatform(); // Fixed Windows refusal, before helper/key/engine side effects.
    copiedKey = Buffer.from(options.credentialKey);
    const { bundleDir, dataDir, tempDir, clientKind } = options;
    for (const p of [bundleDir,dataDir,tempDir]) if (typeof p !== 'string' || !path.isAbsolute(p) || path.normalize(p) !== p) throw failure('PRIVATE_PATH');
    if (inside(bundleDir,dataDir) || inside(dataDir,bundleDir) || inside(bundleDir,tempDir) || inside(tempDir,bundleDir) || inside(dataDir,tempDir) || inside(tempDir,dataDir)) throw failure('PRIVATE_PATH');
    const manifest = await loadManifest(bundleDir);
    let owned, deadline;
    if (process.platform === 'win32') {
      // Unreachable until native acceptance changes the fixed platform gate.
      const { HostPrivateFilesSession } = require('./windows-private-files');
      const session = HostPrivateFilesSession.start(bundleDir); const roots = [];
      try { roots.push(await session.openPrivateDirectory(dataDir)); roots.push(await session.openPrivateDirectory(tempDir)); }
      finally { for (const root of roots) await session.closeRoot(root).catch(() => {}); await session.close().catch(() => {}); }
      deadline = Date.now() + START_TIMEOUT;
      owned = await require('./windows-launch').launchOwned({ verifiedBundle: { bundleDir, version:manifest.version, java:manifest.java, resources:manifest.resources, classpath:manifest.classpath }, dataDir,tempDir });
    } else {
      await privateDirectory(dataDir); await privateDirectory(tempDir);
      const argv = ['--add-modules','jdk.httpserver','-Djava.io.tmpdir='+tempDir,'-Dorg.sqlite.tmpdir='+tempDir,'-cp',manifest.classpath.join(path.delimiter),'com.peentar.thriftquery.LocalEngineMain','--resources',manifest.resources,'--data-dir',dataDir,'--temp-dir',tempDir];
      deadline = Date.now() + START_TIMEOUT;
      const child = spawn(manifest.launcher,[String(process.pid),manifest.java,...argv],{shell:false,cwd:dataDir,env:scrubEnvironment(dataDir,tempDir),stdio:['pipe','pipe','pipe'],windowsHide:true});
      let exited = false, stopPromise;
      const closed = new Promise(resolve => child.once('close',(code,signal) => { exited = true; resolve({ java:{observed:true,code,signal} }); }));
      child.stderr.on('data',()=>{}); child.on('error',()=>{});
      owned = { expectedJavaPid:child.pid,stdin:child.stdin,stdout:child.stdout,closed,stop() {
        if (!stopPromise) stopPromise = (async()=>{ if (exited) return; child.stdin.end(); const timer=setTimeout(()=>{if(!exited)child.kill('SIGKILL');},STOP_TIMEOUT);try{await closed;}finally{clearTimeout(timer);} })();
        return stopPromise;
      } };
    }
    return await startOwnedEngine(owned,{version:manifest.version,credentialKey:copiedKey,clientKind,deadline});
  } catch(error) { throw failure(['PRIVATE_PATH','INVALID_MANIFEST','WINDOWS_PRIVATE_STORAGE_UNSUPPORTED','START_TIMEOUT','INVALID_READY','AUTH_FAILED','ENGINE_EXITED'].includes(error.code)?error.code:'START_FAILED'); }
  finally { copiedKey?.fill(0); }
};
module.exports = { EngineClient };
