'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto'); const { spawn } = require('node:child_process');
const { HostPrivateFilesSession, RpcTransport } = require('../../packages/local-engine/windows-private-files');
const key = Buffer.alloc(32, 71);
function storage(mode = '') {
  return {
    getSelectedStorageBackend() { throw Error('must not query Linux backend'); },
    async isAsyncEncryptionAvailable() { if (mode === 'availability') throw Error('synthetic-secret'); return mode !== 'unavailable'; },
    async encryptStringAsync(text) { if (mode === 'encrypt') throw Error('synthetic-secret'); const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(text), c.final()]); return Buffer.concat([Buffer.from(mode === 'tag' ? 'v11' : 'v10'), iv, c.getAuthTag(), body]); },
    async decryptStringAsync(b) { if (mode === 'decrypt') throw Error('synthetic-secret'); const c = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(3,15)); c.setAuthTag(b.subarray(15,31)); return { result: mode === 'roundtrip' ? Buffer.alloc(32, 9).toString('base64url') : Buffer.concat([c.update(b.subarray(31)), c.final()]).toString(), shouldReEncrypt: mode === 'rotate' }; }
  };
}
function envelope(mode, backend, payload) {
  const tag = Buffer.from(backend), h = Buffer.alloc(6); h[0] = mode; h[1] = tag.length; h.writeUInt32BE(payload.length,2);
  const b = Buffer.concat([Buffer.from('GBKEY1\0'),h,tag,payload]); return Buffer.concat([b, crypto.createHash('sha256').update(b).digest()]);
}
async function fixture(t, config = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-windows-b-key-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = path.join(dir,'store'); await fs.mkdir(store); const trace = path.join(dir, 'trace');
  const cfg = path.join(dir,'config.json'); await fs.writeFile(cfg, JSON.stringify({ ...config, store, trace }));
  const child = spawn(process.execPath, [path.resolve(__dirname,'../../packages/local-engine/test/windows-host-rpc-fixture.cjs'),cfg], { stdio: ['pipe','pipe','pipe'] });
  const rpc = new RpcTransport(child), session = new HostPrivateFilesSession(rpc); t.after(() => rpc.abort());
  const frames=[];const write=child.stdin.write.bind(child.stdin);child.stdin.write=(b,...args)=>{frames.push(Buffer.from(b));return write(b,...args);};
  return { store, session, rpc, frames, trace: async () => (await fs.readFile(trace,'utf8')).trim().split('\n').map(JSON.parse), load(s = storage(), platform = 'win32', ready = true) { return require('../windows-key-store.cjs').createWindowsKeyProvider({ session, safeStorage: s, platform, app: { isReady: () => ready } }); } };
}
const options = { allowPlaintextFallback: false };
test('native-session Windows key create/reopen uses encrypted GBKEY1 and retains exact bytes on rotation', async t => {
  const f = await fixture(t), load = f.load(); const raw = await load('C:\\Private', options); assert.equal(raw.length,32);
  const before = await fs.readFile(path.join(f.store,'credential-key.v1')); assert.equal(before.subarray(0,7).toString(),'GBKEY1\0'); assert(!before.includes(raw)); assert(!before.includes(Buffer.from(raw.toString('base64url'))));
  for(const frame of f.frames){assert(!frame.includes(raw));assert(!frame.includes(Buffer.from(raw.toString('base64url'))));}
  assert.deepEqual(await f.load(storage('rotate'))('C:\\Private',options),raw); assert.deepEqual(await fs.readFile(path.join(f.store,'credential-key.v1')),before);
  assert.deepEqual(await fs.readdir(f.store),['credential-key.v1']); assert.equal(f.session.roots.size,0); assert.equal(f.rpc.dead,false);
  const trace = await f.trace(); assert.deepEqual(trace.filter(v=>typeof v.op==='number').map(v=>v.op),[2,3,4,3,6,5,7,11,2,3,5,11]); assert.equal(trace.filter(v=>v.op==='envelope').length,1);
});
for (const [mode,code,claim] of [['availability','KEY_BACKEND_UNAVAILABLE',false],['unavailable','KEY_BACKEND_UNAVAILABLE',false],['encrypt','KEY_UNAVAILABLE',true],['decrypt','KEY_UNAVAILABLE',true],['roundtrip','KEY_UNAVAILABLE',true],['tag','KEY_BACKEND_UNAVAILABLE',true]]) test('Windows key refuses '+mode+' without plaintext or claim rollback', async t => {
  const f = await fixture(t); await assert.rejects(f.load(storage(mode))('C:\\Private',{allowPlaintextFallback:true}),e=>e.code===code&&!String(e).includes('synthetic-secret'));
  assert.deepEqual(await fs.readdir(f.store), claim ? ['.credential-key.init'] : []); assert.equal(f.session.roots.size,0);
});
for (const [name,bytes,code] of [
  ['mode2',envelope(2,'linux-plaintext',Buffer.alloc(32)),'KEY_UNAVAILABLE'],
  ['Linux backend',envelope(1,'gnome_libsecret',Buffer.from('v11encrypted')),'KEY_UNAVAILABLE'],
  ['wrong tag',envelope(1,'windows-dpapi',Buffer.from('v12encrypted')),'KEY_BACKEND_UNAVAILABLE'],
  ['corrupt',Buffer.from('partial'),'KEY_UNAVAILABLE'],
  ['empty',Buffer.alloc(0),'KEY_UNAVAILABLE']
]) test('Windows established '+name+' is refused unchanged',async t=>{
  const f=await fixture(t), file=path.join(f.store,'credential-key.v1'); await fs.writeFile(file,bytes);
  await assert.rejects(f.load()('C:\\Private',options),{code}); assert.deepEqual(await fs.readFile(file),bytes); assert.deepEqual(await fs.readdir(f.store),['credential-key.v1']);
});
for (const [name,code] of [['local-workspace.json','KEY_MISSING'],['credential-KEY.v1','KEY_UNAVAILABLE'],['key-consent.v1.json','KEY_MISSING'],['.credential-key.init','KEY_INITIALIZING']]) test('Windows initial state refuses '+name, async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.store,name),'fixture');await assert.rejects(f.load()('C:\\Private',options),{code});assert.deepEqual(await fs.readdir(f.store),[name]);
});
test('post-claim late winner is reopened unchanged and only acquired claim is finished',async t=>{
  const raw=Buffer.alloc(32,19),bytes=envelope(1,'windows-dpapi',await storage().encryptStringAsync(raw.toString('base64url')));const f=await fixture(t,{lateKey:bytes.toString('base64')});
  assert.deepEqual(await f.load()('C:\\Private',options),raw);assert.deepEqual(await fs.readFile(path.join(f.store,'credential-key.v1')),bytes);assert.deepEqual(await fs.readdir(f.store),['credential-key.v1']);assert.equal((await f.trace()).filter(v=>v.op===6).length,0);
});
test('established Windows decrypt/availability failure never rewrites bytes or creates a claim',async t=>{
  const f=await fixture(t);await f.load()('C:\\Private',options);const file=path.join(f.store,'credential-key.v1'),before=await fs.readFile(file);
  for(const [mode,code]of [['decrypt','KEY_UNAVAILABLE'],['availability','KEY_BACKEND_UNAVAILABLE']]){await assert.rejects(f.load(storage(mode))('C:\\Private',options),{code});assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readdir(f.store),['credential-key.v1']);}
});
test('partial persisted envelope leaves failed acquired claim and never regenerates',async t=>{
  const f=await fixture(t,{partial:true});await assert.rejects(f.load()('C:\\Private',options),{code:'KEY_UNAVAILABLE'});const before=await fs.readFile(path.join(f.store,'credential-key.v1'));await assert.rejects(f.load()('C:\\Private',options),{code:'KEY_INITIALIZING'});assert.deepEqual(await fs.readFile(path.join(f.store,'credential-key.v1')),before);assert.equal((await f.trace()).filter(v=>v.op===7).length,0);
});
for(const [status,code] of [[3,'KEY_INITIALIZING'],[4,'KEY_UNAVAILABLE'],[6,'KEY_UNAVAILABLE']]) test('native claim status '+status+' maps fixed error without retry',async t=>{
  const f=await fixture(t,{statuses:{4:status}});await assert.rejects(f.load()('C:\\Private',options),{code});assert.equal((await f.trace()).filter(v=>v.op===4).length,1);assert.equal(f.session.roots.size,0);
});
test('wrong platform and app-not-ready have no native side effects; default public provider stays blocked',async t=>{
  const f=await fixture(t);await assert.rejects(f.load(storage(),'linux')('C:\\Private',options),{code:'WINDOWS_PRIVATE_STORAGE_UNSUPPORTED'});await assert.rejects(f.load(storage(),'win32',false)('C:\\Private',options),{code:'APP_NOT_READY'});assert.equal(f.session.roots.size,0);
  await assert.rejects(require('../key-store.cjs').createKeyProvider({app:{isReady:()=>true},safeStorage:storage(),platform:'win32'})('C:\\Private',options),{code:'WINDOWS_PRIVATE_STORAGE_UNSUPPORTED'});
});
test('Windows GBKEY1 rejects high-bit backend aliases',async t=>{
  const f=await fixture(t);const bytes=envelope(1,'windows-dpapi',await storage().encryptStringAsync(Buffer.alloc(32,8).toString('base64url')));bytes[13]|=128;crypto.createHash('sha256').update(bytes.subarray(0,-32)).digest().copy(bytes,bytes.length-32);
  await fs.writeFile(path.join(f.store,'credential-key.v1'),bytes);await assert.rejects(f.load()('C:\\Private',options),{code:'KEY_UNAVAILABLE'});
});
test('two actual helper processes contend exclusively and reopen unchanged winner',async t=>{
  const f=await fixture(t);const dir=path.dirname(f.store),cfg=path.join(dir,'contender.json');await fs.writeFile(cfg,JSON.stringify({store:f.store}));
  const child=spawn(process.execPath,[path.resolve(__dirname,'../../packages/local-engine/test/windows-host-rpc-fixture.cjs'),cfg],{stdio:['pipe','pipe','pipe']});const rpc=new RpcTransport(child),session=new HostPrivateFilesSession(rpc);t.after(()=>rpc.abort());
  let enter,release;const entered=new Promise(r=>enter=r),barrier=new Promise(r=>release=r);const slow=storage();const encrypt=slow.encryptStringAsync;slow.encryptStringAsync=async text=>{enter();await barrier;return encrypt(text);};
  const winner=f.load(slow)('C:\\Private',options);const observed=winner.then(value=>({value}),error=>({error}));await entered;
  const contender=require('../windows-key-store.cjs').createWindowsKeyProvider({session,safeStorage:storage(),platform:'win32',app:{isReady:()=>true}});
  try{await assert.rejects(contender('C:\\Private',options),{code:'KEY_INITIALIZING'});assert.equal((await fs.readdir(f.store)).includes('.credential-key.init'),true);}finally{release();}
  const result=await observed;assert.ifError(result.error);assert.deepEqual(await contender('C:\\Private',options),result.value);assert.deepEqual(await fs.readdir(f.store),['credential-key.v1']);
});
module.exports={storage,envelope,fixture};
