'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path'); const { spawn } = require('node:child_process');
const { attachOwned } = require('../windows-launch');
async function start(t, mode = 'ready', timeout = 2000) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'task5-windows-b-owned-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const trace=path.join(dir,'trace');
  const deadline=Date.now()+timeout;
  const child=spawn(process.execPath,[path.join(__dirname,'windows-owned-engine-fixture.cjs'),mode,trace],{stdio:['pipe','pipe','pipe']});let closed=false;child.once('close',()=>{closed=true;});t.after(()=>child.kill('SIGKILL'));
  const ownedPromise=attachOwned(child,{event:'LaunchOwned'},'1.4.0',{timeout});
  let owned;
  try { owned=await ownedPromise; const client=await require('../owned-engine-client').startOwnedEngine(owned,{version:'1.4.0',credentialKey:Buffer.alloc(32,7),clientKind:'desktop',deadline});return {client,child,owned,trace:async()=>(await fs.readFile(trace,'utf8')).trim().split('\n').map(JSON.parse)}; }
  catch(e) { if(owned)assert.equal(closed,true,'startup rejection must await owned close');throw e; }
}
test('owned-wrapper common client authenticates exact Java PID and filters headers/actor',async t=>{
  const {client,owned,trace}=await start(t);t.after(()=>client.stop());
  assert.notEqual(owned.expectedJavaPid,process.pid);assert.deepEqual(Object.keys(client),[]);
  const result=await client.request({method:'GET',path:'/api/connections'});assert.deepEqual(result.headers,{'content-type':'application/json','x-request-id':'12345678-1234-1234-1234-123456789abc','x-gridbase-audit-warning':'incomplete'});
  const invalid=await client.request({method:'GET',path:'/api/health'});assert.equal(invalid.headers['x-gridbase-audit-warning'],undefined);
  const calls=await trace();assert.equal(calls.every(v=>v.authenticated),true);assert.equal(calls[0].actor,null);assert.equal(calls.at(-1).actor,'local:12345678-1234-1234-1234-123456789abc');
  const exits=[];client.onExit(e=>exits.push(e));const stop=client.stop();assert.equal(stop,client.stop());await stop;assert.deepEqual(exits,[{code:17,signal:null}]);await client.stop();
});
for(const mode of ['pid','version','reflection-ready','extra','bad-health','bad-auth','admin','exit']) test('owned-wrapper startup refuses '+mode+' and awaits cleanup',async t=>{
  await assert.rejects(start(t,mode),e=>['ENGINE_EXITED','INVALID_READY','AUTH_FAILED','START_FAILED'].includes(e.code)&&!String(e).includes('synthetic-secret'));
});
test('one shared deadline spans bind/Owned/readiness/auth, not another 30s timer',async t=>{
  const before=Date.now();await assert.rejects(start(t,'deadline',300),{code:'START_TIMEOUT'});assert(Date.now()-before<1500);
});
test('wrapper-only close never fabricates Java exit code or signal',async t=>{
  const {client}=await start(t,'wrapper-only');const exits=[];client.onExit(e=>exits.push(e));await client.stop();assert.deepEqual(exits,[{code:null,signal:null}]);let late;client.onExit(e=>{late=e;});await new Promise(r=>setImmediate(r));assert.deepEqual(late,{code:null,signal:null});
});
for(const mode of ['exit-write','drop-write'])test('submitted '+mode+' is uncertain and never resubmitted',async t=>{
  const {client,trace}=await start(t,mode);try{await assert.rejects(client.request({method:'POST',path:'/api/query',body:{sql:'UPDATE fixture SET x=1'}}),e=>e.uncertainOutcome===true&&['ENGINE_EXITED','REQUEST_FAILED'].includes(e.code));assert.equal((await trace()).filter(v=>v.path==='/api/query').length,1);}finally{await client.stop();}
});
for(const [mode,code]of [['reflect','REQUEST_FAILED'],['redirect','REDIRECT_DENIED']])test('owned facade refuses '+mode,async t=>{const{client}=await start(t,mode);try{await assert.rejects(client.request({method:'GET',path:'/api/connections'}),{code});}finally{await client.stop();}});
test('owned EOF after partial readiness is invalid immediately, not a full readiness timeout',async()=>{
  const {PassThrough}=require('node:stream');const stdin=new PassThrough(),stdout=new PassThrough();let done;const closed=new Promise(r=>done=r);let stopped=0;
  const owned={expectedJavaPid:42,stdin,stdout,closed,stop(){stopped++;done({java:{observed:false,code:null}});return closed;}};
  stdin.once('data',()=>{stdout.write('{"event":"ready"');stdout.end();});
  await assert.rejects(require('../owned-engine-client').startOwnedEngine(owned,{version:'1.4.0',credentialKey:Buffer.alloc(32),clientKind:'desktop',deadline:Date.now()+150}),{code:'INVALID_READY'});assert.equal(stopped,1);
});
test('public win32 start rejects before any missing installed-helper/private-root side effect',async()=>{
  const source=`Object.defineProperty(process,'platform',{value:'win32'});const {EngineClient}=require(${JSON.stringify(path.resolve(__dirname,'..'))});EngineClient.start({bundleDir:'C:\\\\never-installed',dataDir:'C:\\\\never-data',tempDir:'C:\\\\never-temp',clientKind:'desktop',credentialKey:Buffer.alloc(32)}).then(()=>process.exit(2)).catch(e=>{process.stdout.write(e.code);process.exitCode=e.code==='WINDOWS_PRIVATE_STORAGE_UNSUPPORTED'?0:3;});`;
  const child=spawn(process.execPath,['-e',source],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);const code=await new Promise(r=>child.once('close',r));assert.equal(code,0);assert.equal(output,'WINDOWS_PRIVATE_STORAGE_UNSUPPORTED');assert.equal(errors,'');
});
test('public EngineClient has no transport/endpoint/platform/deadline overrides',async()=>{
  const {EngineClient}=require('..');for(const extra of [{platform:'win32'},{endpoint:'http://127.0.0.1:1'},{deadline:1},{owned:{}}])await assert.rejects(EngineClient.start({bundleDir:'/missing',dataDir:'/data',tempDir:'/temp',clientKind:'desktop',credentialKey:Buffer.alloc(32),...extra}),{code:'START_FAILED'});
});
