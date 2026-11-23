'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process'); const crypto = require('node:crypto');
test('native Windows Electron45 DPAPI create/quit/reopen plus actual packaged JRE17 authenticated lifecycle', {
  skip:process.platform!=='win32'?'UNVERIFIED: requires Windows11 disposable profile, actual Electron45.4.1, trusted installed fixture bundle/JRE17':false,
  timeout:180000
},()=>{
  const electron=process.env.GRIDBASE_WINDOWS_ELECTRON, bundle=process.env.GRIDBASE_WINDOWS_NATIVE_BUNDLE, observations=process.env.GRIDBASE_WINDOWS_OBSERVATIONS;
  assert.equal(process.env.GRIDBASE_WINDOWS_DISPOSABLE_PROFILE,'1','Explicit disposable profile required; fixed KnownFolder data must be empty');
  for(const p of [electron,bundle,observations])assert(p&&path.isAbsolute(p),'Native host fixture prerequisite paths required');
  assert(fs.statSync(electron).isFile());assert(fs.statSync(bundle).isDirectory());assert(fs.statSync(observations).isDirectory());
  // The fixture bundle is a packaging prerequisite, never generated from this
  // working tree or downloaded here. Verify actual selected Java17, not a stub.
  const manifest=JSON.parse(fs.readFileSync(path.join(bundle,'engine/manifest.json'),'utf8'));
  const java=cp.spawnSync(path.join(bundle,manifest.java),['-version'],{encoding:'utf8',timeout:10000});assert.equal(java.status,0);assert.match(java.stderr,/version "17\./);
  const observation=path.join(observations,'host-'+crypto.randomUUID()+'.json');
  try{for(const mode of ['create','reopen']){
    const result=cp.spawnSync(electron,[path.join(__dirname,'windows-native-host-fixture.cjs'),bundle,mode,observation],{encoding:'utf8',timeout:70000,windowsHide:true});
    assert.equal(result.status,0,'Actual Electron/JRE host fixture failed');assert.match(result.stdout,/NATIVE_ELECTRON_JRE_HOST_OK/);
  }}finally{fs.rmSync(observation,{force:true});}
});
