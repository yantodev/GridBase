'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { spawn } = require('node:child_process');
const { RpcTransport, HostPrivateFilesSession } = require('../windows-private-files');
function fixture(mode = 'split') {
  // Real executable transport fixture, NOT an implementation of WinAPI security.
  return spawn(process.execPath, ['-e', `const p=require(${JSON.stringify(require.resolve('../windows-protocol'))}); const d=new p.FrameDecoder(); process.stderr.write('untrusted-secret'); process.stdin.on('data',b=>{for(const f of d.push(b)){if(${JSON.stringify(mode)}==='hang')continue; if(${JSON.stringify(mode)}==='eof'){process.exit();return;} const out=p.frame(0,${JSON.stringify(mode)}==='id'?f.id+1:f.id,Buffer.from([0,0,0,0,0]));process.stdout.write(out.subarray(0,2));setTimeout(()=>process.stdout.write(out.subarray(2)),2);}});`], { stdio: ['pipe','pipe','pipe'] });
}
test('binary transport real process: one outstanding, monotonic IDs and redacted failures', async () => {
  const rpc = new RpcTransport(fixture(), { timeout: 1000 });
  const pending = rpc.request(3, { root: 1 }); await assert.rejects(rpc.request(3, { root: 1 }), { code: 'WINDOWS_BUSY' });
  assert.equal((await pending).key, false); assert.equal((await rpc.request(3, { root: 1 })).claim, false); await rpc.abort();
  for (const mode of ['id','eof','hang']) {
    const other = new RpcTransport(fixture(mode), { timeout: 150 });
    await assert.rejects(other.request(3, { root: 1 }), e => /^WINDOWS_/.test(e.code) && !JSON.stringify(e).includes('untrusted-secret'));
    await other.closed;
  }
});
for(const mode of ['timeout','malformed','eof','session','validation','wrap']) test('terminal RPC '+mode+' awaits real owned-child close before rejection', async () => {
  const script=`process.stdin.resume();process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),80));process.stdout.write('');${mode==='malformed'?"setTimeout(()=>process.stdout.write(Buffer.from([255,255,255,255])),20);":mode==='eof'?"setTimeout(()=>process.stdout.end(),20);":''}setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['-e',script],{stdio:['pipe','pipe','pipe']});
  let observed=false;child.once('close',()=>{observed=true;});
  const rpc=new RpcTransport(child,{timeout:mode==='timeout'?100:1000,total:mode==='session'?80:2000});
  try {
   if(mode==='wrap')rpc.next=0x100000000;
   const request=rpc.request(mode==='validation'?99:3,{root:1});
   const expected=['timeout','session'].includes(mode)?'WINDOWS_TIMEOUT':mode==='eof'?'WINDOWS_EOF':'WINDOWS_PROTOCOL';
   await assert.rejects(request,{code:expected});
   assert.equal(observed,true,mode+' rejected before real close observation');
   assert.ok(child.exitCode!==null||child.signalCode!==null);
   const again=rpc.stop('WINDOWS_IO');assert.equal(again,rpc.stop('WINDOWS_EOF'),'cleanup promise must be idempotent');
  } finally { child.kill('SIGKILL');await rpc.abort(); }
});
test('claimed ID cannot be reused as another root or bundle and request IDs never wrap', async () => {
 const fake={request:async()=>1};const s=new HostPrivateFilesSession(fake);await s.openPrivateDirectory('C:\\private');
 await assert.rejects(s.openBundle('C:\\installed'),{code:'WINDOWS_PROTOCOL'});
 const rpc=new RpcTransport(fixture(),{timeout:1000});rpc.next=0x100000000;await assert.rejects(rpc.request(3,{root:1}),{code:'WINDOWS_PROTOCOL'});await rpc.closed;
});
test('session claim IDs are rooted, successful read plus trusted decrypt assertion required', async () => {
  const calls = []; const fake = { request: async (op,v) => { calls.push([op,v]); return op===2?1:op===4?2:op===5?Buffer.from('envelope'):undefined; } };
  const s = new HostPrivateFilesSession(fake); const root = await s.openPrivateDirectory('C:\\private'); const claim = await s.beginKeyClaim(root);
  assert.throws(()=>s.createKey(77,claim,Buffer.alloc(0)));
  await assert.rejects(s.finishKeyClaim(root,claim,true));
  await s.readKey(root); await assert.rejects(s.finishKeyClaim(root,claim,false));
  await s.finishKeyClaim(root,claim,true); assert.throws(()=>s.createKey(root,claim,Buffer.alloc(0)));
  assert.equal(calls.filter(([op])=>op===7).length,1);
});
test('production Windows private helper factory fails closed on non-Windows', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => HostPrivateFilesSession.start('C:\\installed'), { code: 'WINDOWS_UNSUPPORTED' });
  assert.throws(() => HostPrivateFilesSession.prepareDesktopSync('C:\\installed'), { code: 'WINDOWS_UNSUPPORTED' });
});
