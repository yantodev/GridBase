'use strict';
// Real WinAPI acceptance only. Linux skips are intentional, never WinAPI mocks.
// Windows runner must provide crossbuilt native-fixture.exe + both helper EXEs
// in GRIDBASE_WINDOWS_FIXTURE_DIR and a disposable test account/profile.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const cp=require('node:child_process');
const {RpcTransport,HostPrivateFilesSession}=require('../windows-private-files');
const native={skip:process.platform!=='win32'?'UNVERIFIED: requires native Windows 11, NTFS and disposable profile':false};
function binaries(){const dir=process.env.GRIDBASE_WINDOWS_FIXTURE_DIR;assert.ok(dir&&path.isAbsolute(dir),'Native fixture directory is required');return {dir,helper:path.join(dir,'gridbase-private-files.exe'),fixture:path.join(dir,'native-fixture.exe')};}
function session(helper){return new HostPrivateFilesSession(new RpcTransport(cp.spawn(helper,[],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']})));}
function privateRoot(fixture){const root=path.join(os.tmpdir(),'GridBase-native-'+require('node:crypto').randomUUID());const r=cp.spawnSync(fixture,[root],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,'native ACL/identity/claim fixture failed with exit '+r.status);assert.equal(r.stdout.trim(),'NATIVE_PRIVATE_FIXTURE_OK');return root;}
test('native Windows protected creation, hardlink rejection, exclusive claim, broad parent unchanged',native,()=>{
 const {fixture}=binaries();let root;try{root=privateRoot(fixture);}finally{if(root)fs.rmSync(root,{recursive:true,force:true});}
});
test('native Windows two independent helper processes claim exactly once, persist and late-winner reopen',native,async()=>{
 const {helper,fixture}=binaries();const root=privateRoot(fixture),a=session(helper),b=session(helper);
 try{const ar=await a.openPrivateDirectory(root),br=await b.openPrivateDirectory(root);const races=await Promise.allSettled([a.beginKeyClaim(ar),b.beginKeyClaim(br)]);assert.equal(races.filter(x=>x.status==='fulfilled').length,1);
  const winner=races[0].status==='fulfilled'?a:b,loser=winner===a?b:a,wr=winner===a?ar:br,lr=winner===a?br:ar,claim=races.find(x=>x.status==='fulfilled').value;
  const envelope=Buffer.from('synthetic-encrypted-envelope-not-a-real-key');await winner.createKey(wr,claim,envelope);assert.deepEqual(await winner.readKey(wr),envelope);await winner.finishKeyClaim(wr,claim,true);
  const late=await loser.beginKeyClaim(lr);assert.equal((await loser.keyState(lr)).key,true);assert.deepEqual(await loser.readKey(lr),envelope);await assert.rejects(loser.createKey(lr,late,envelope),{code:'WINDOWS_EXISTS'});await loser.readKey(lr);await loser.finishKeyClaim(lr,late,true);
  assert.deepEqual(fs.readFileSync(path.join(root,'credential-key.v1')),envelope);
 }finally{await a.rpc.abort();await b.rpc.abort();fs.rmSync(root,{recursive:true,force:true});}
});
test('native Windows crashed initializer retains claim; no PID/expiry takeover',native,async()=>{
 const {helper,fixture}=binaries();const root=privateRoot(fixture),a=session(helper);let b;
 try{const r=await a.openPrivateDirectory(root);await a.beginKeyClaim(r);await a.rpc.abort();assert.equal(fs.existsSync(path.join(root,'.credential-key.init')),true);b=session(helper);const br=await b.openPrivateDirectory(root);await assert.rejects(b.beginKeyClaim(br),{code:'WINDOWS_INITIALIZING'});}
 finally{await a.rpc.abort();if(b)await b.rpc.abort();fs.rmSync(root,{recursive:true,force:true});}
});
test('native Windows readonly bundle inventory hashes every file and rejects hardlinked files',native,async()=>{
 const {helper,fixture}=binaries();const root=privateRoot(fixture),s=session(helper);
 try{fs.mkdirSync(path.join(root,'nested'));fs.writeFileSync(path.join(root,'nested','fixture.bin'),Buffer.from('inventory fixture'));const id=await s.openBundle(root);const page=await s.scanBundlePage(id,0);assert.equal(page.next,0);const file=page.entries.find(x=>x.path==='nested/fixture.bin');assert.equal(file.sha256,require('node:crypto').createHash('sha256').update('inventory fixture').digest('hex'));assert.deepEqual(await s.readBundleFile(id,'nested/fixture.bin',1024),Buffer.from('inventory fixture'));await s.closeBundle(id);
  fs.linkSync(path.join(root,'nested','fixture.bin'),path.join(root,'alias.bin'));const second=await s.openBundle(root);await assert.rejects(s.scanBundlePage(second),{code:'WINDOWS_UNSAFE'});
 }finally{await s.rpc.abort();fs.rmSync(root,{recursive:true,force:true});}
});
