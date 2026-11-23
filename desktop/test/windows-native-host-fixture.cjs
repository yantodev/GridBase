'use strict';
// Actual Electron-only acceptance fixture; no safeStorage adapter or gate bypass.
const { app, safeStorage } = require('electron'); const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { HostPrivateFilesSession } = require('../../packages/local-engine/windows-private-files');
const { loadWindowsManifest } = require('../../packages/local-engine/windows-manifest');
const { launchOwned } = require('../../packages/local-engine/windows-launch');
const { startOwnedEngine } = require('../../packages/local-engine/owned-engine-client');
const { createWindowsKeyProvider } = require('../windows-key-store.cjs');
const [bundleDir, mode, observation] = process.argv.slice(2); let session;
function refuse() { process.stderr.write('NATIVE_HOST_FIXTURE_FAILED\n'); app.exit(1); }
try {
  if (process.platform !== 'win32' || process.versions.electron !== '45.4.1' || process.env.GRIDBASE_WINDOWS_DISPOSABLE_PROFILE !== '1') throw Error();
  const prepared = HostPrivateFilesSession.prepareDesktopSync(bundleDir);
  app.setPath('userData', prepared.sessionDir); app.setPath('sessionData', prepared.sessionDir);
  app.whenReady().then(async () => {
    session = HostPrivateFilesSession.start(bundleDir);
    const initialRoot=await session.openPrivateDirectory(prepared.dataDir);
    try {
      const state=await session.keyState(initialRoot);
      if(mode==='create'&&Object.values(state).some(Boolean))throw Error();
      if(mode==='reopen'&&(!state.key||state.claim||state.alias||state.consent))throw Error();
    } finally { await session.closeRoot(initialRoot); }
    const load = createWindowsKeyProvider({ session,app,safeStorage });
    const raw = await load(prepared.dataDir,{allowPlaintextFallback:false});
    try {
      const root = await session.openPrivateDirectory(prepared.dataDir); let bytes;
      try { bytes = await session.readKey(root); } finally { await session.closeRoot(root); }
      const current = { keyDigest:crypto.createHash('sha256').update(raw).digest('hex'),envelopeDigest:crypto.createHash('sha256').update(bytes).digest('hex') }; bytes.fill(0);
      if(mode==='create') fs.writeFileSync(observation,JSON.stringify(current),{flag:'wx'});
      else if(mode==='reopen') { const prior=JSON.parse(fs.readFileSync(observation,'utf8'));if(prior.keyDigest!==current.keyDigest||prior.envelopeDigest!==current.envelopeDigest)throw Error(); }
      else throw Error();
      const manifest=await loadWindowsManifest(session,bundleDir);
      const deadline=Date.now()+30000;
      const owned=await launchOwned({verifiedBundle:{bundleDir,...manifest},dataDir:prepared.dataDir,tempDir:prepared.tempDir});
      const client=await startOwnedEngine(owned,{version:manifest.version,credentialKey:raw,clientKind:'desktop',deadline});
      try { const health=await client.request({method:'GET',path:'/healthz'});if(health.status!==200)throw Error(); } finally { await client.stop(); }
      process.stdout.write('NATIVE_ELECTRON_JRE_HOST_OK\n');
    } finally { raw.fill(0); await session.close(); }
    app.exit(0);
  }).catch(async()=>{if(session)await session.rpc.abort();refuse();});
} catch { refuse(); }
