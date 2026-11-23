'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os'); const vm = require('node:vm');
const { createProtocolHandler, privilegedScheme } = require('../protocol.cjs');
const { preparePaths, preparePathsBeforeReady, applicationRoot, windowOptions, secureContents } = require('../shell.cjs');
test('packaged protocol is offline, strict allowlist and CSP, and substitutes only native session entry', async () => {
  const handler = createProtocolHandler(path.resolve(__dirname, '../..'));
  const response = await handler({ method: 'GET', url: 'gridbase://app/index.html' });
  assert.equal(response.status, 200); const text = await response.text();
  assert.match(text, /\/local-session.js/); assert.match(text, /\/runtime-transport.js/); assert.doesNotMatch(text, /src="\/session.js"|https:\/\//);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/); assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(privilegedScheme.privileges.standard, true); assert.equal(privilegedScheme.privileges.secure, true); assert.notEqual(privilegedScheme.privileges.bypassCSP, true);
  for (const url of ['https://app/index.html', 'gridbase://evil/index.html', 'gridbase://u@app/index.html', 'gridbase://app:80/index.html', 'gridbase://app/index.html?x', 'gridbase://app/index.html#x', 'gridbase://app/%2e%2e/index.html', 'gridbase://app/a/../index.html', 'gridbase://app/%2fapp.js', 'gridbase://app/%5capp.js', 'gridbase://app/desktop/key-store.cjs', 'gridbase://app/session.js', 'gridbase://app/not-here']) assert.equal((await handler({ method: 'GET', url })).status, 404, url);
  assert.equal((await handler({ method: 'POST', url: 'gridbase://app/index.html' })).status, 405);
  assert.match((await handler({ method: 'GET', url: 'gridbase://app/app.js' })).headers.get('content-type'), /javascript/);
});
test('private native directories are prepared before Chromium paths; absent/unsafe appData and Windows refuse without creation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task6-paths-')); t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.chmod(root, 0o700);
  const appData = path.join(root, 'appData'); await fs.mkdir(appData, { mode: 0o700 }); const changes = [];
  const app = { getPath: name => { assert.equal(name, 'appData'); return appData; }, setPath: (name, value) => changes.push([name, value]) };
  const paths = await preparePaths(app, 'linux'); assert.equal(paths.dataDir, path.join(appData, 'GridBaseDesktop/engine-data')); assert.equal(changes.length, 2);
  for (const name of ['GridBaseDesktop', 'GridBaseDesktop/engine-data', 'GridBaseDesktop/engine-temp', 'GridBaseDesktop/chromium']) assert.equal((await fs.stat(path.join(appData, name))).mode & 0o777, 0o700);
  await assert.rejects(preparePaths({ getPath: () => path.join(root, 'absent'), setPath() { assert.fail(); } }, 'linux'));
  await assert.rejects(fs.stat(path.join(root, 'absent')));
  await assert.rejects(preparePaths({ getPath() { assert.fail(); }, setPath() { assert.fail(); } }, 'win32'), e => e.code === 'WINDOWS_PRIVATE_STORAGE_UNSUPPORTED');
  await fs.chmod(appData, 0o755); await assert.rejects(preparePaths(app, 'linux')); assert.equal(changes.length, 2);
});
test('Chromium paths are prepared synchronously before ready and source/package application roots are trusted',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'task6-preready-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.chmod(root,0o700);const changes=[];
  const app={getPath:()=>root,setPath:(name,value)=>changes.push([name,value]),isReady:()=>false};
  const paths=preparePathsBeforeReady(app,'linux');assert.equal(typeof paths.then,'undefined');assert.equal(changes.length,2);assert.equal(paths.dataDir,path.join(root,'GridBaseDesktop/engine-data'));
  assert.throws(()=>preparePathsBeforeReady({...app,isReady:()=>true},'linux'));
  assert.equal(applicationRoot({isPackaged:true,getAppPath:()=>'/installed/app.asar'}),'/installed/app.asar');assert.equal(applicationRoot({isPackaged:false,getAppPath:()=>'/source/desktop'}),'/source');assert.equal(applicationRoot({isPackaged:false,getAppPath:()=>'/trusted/resources/app'}),'/trusted/resources/app');
});
test('production main entry derives only fixed engine resources and registers protocol before ready',async()=>{
  const order=[],handles={};let requested;
  const app={getAppPath:()=>'/trusted/app',isPackaged:true,requestSingleInstanceLock:()=>true,whenReady:async()=>{order.push('ready');},quit(){}};
  const electron={app,protocol:{registerSchemesAsPrivileged:()=>order.push('scheme'),handle:(name,handler)=>{handles[name]=handler;}},dialog:{showMessageBox:()=>assert.fail()}};
  const modules={'electron':electron,'node:path':path,'./protocol.cjs':{createProtocolHandler:root=>{assert.equal(root,'/trusted/app');return ()=>{};},privilegedScheme},'./shell.cjs':{preparePathsBeforeReady:()=>{order.push('private-paths');return {dataDir:'/private/data',tempDir:'/private/temp'};},preparePaths:async()=>{},applicationRoot:()=>'/trusted/app'},'./application.cjs':{startupMessage:()=>'',createApplication:(e,options)=>{requested=options;return {start:async()=>order.push('start')};}},'../packages/local-engine':{EngineClient:{}},'./key-store.cjs':{loadOrCreateKey(){}}};
  vm.runInNewContext(require('node:fs').readFileSync(path.join(__dirname,'../main.cjs'),'utf8'),{require:name=>{assert.ok(Object.hasOwn(modules,name),name);return modules[name];},process:{resourcesPath:'/installed/resources',env:{BUNDLE:'/untrusted'},argv:['/untrusted']}});
  for(let i=0;i<3;i++)await new Promise(setImmediate);assert.deepEqual(order,['scheme','private-paths','ready','start']);assert.equal(requested.bundleDir,'/installed/resources/gridbase-engine');assert.equal(typeof handles.gridbase,'function');
});
test('window sandbox and navigation/permission/download restrictions remain enabled', () => {
  const options = windowOptions('/trusted/app'); assert.equal(options.webPreferences.sandbox, true); assert.equal(options.webPreferences.contextIsolation, true); assert.equal(options.webPreferences.nodeIntegration, false); assert.equal(options.webPreferences.webSecurity, true); assert.equal(options.webPreferences.devTools, false); assert.equal(options.webPreferences.preload, '/trusted/app/desktop/preload.cjs');
  const handlers = {}, sessionHandlers = {}; let windowOpen, permission;
  secureContents({ on: (name, fn) => { handlers[name] = fn; }, setWindowOpenHandler: fn => { windowOpen = fn; }, session: { setPermissionRequestHandler: fn => { permission = fn; }, setPermissionCheckHandler: fn => { assert.equal(fn(), false); }, on: (name, fn) => { sessionHandlers[name] = fn; }, webRequest: { onBeforeRequest: fn => { fn({ url: 'https://evil' }, reply => assert.equal(reply.cancel, true)); } } } });
  let denied = 0; for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) handlers[name]({ preventDefault() { denied++; } }); assert.equal(denied, 3); assert.deepEqual(windowOpen(), { action: 'deny' }); permission(null, null, allowed => assert.equal(allowed, false));
  let download = false; sessionHandlers['will-download']({ preventDefault() { download = true; } }); assert.equal(download, true);
});
test('I2 preload transports plain error data through serialized contexts for all async operations',async()=>{
  const {serializedBridge}=require('./serialized-bridge.cjs');const renderer=vm.createContext({window:{},Headers,TextEncoder});
  let reply={ok:false,error:{code:'USER_CANCELLED',message:'Query cancelled. No SQL was sent.',uncertainOutcome:false}};
  const bridge=serializedBridge(renderer,async()=>reply);
  const input={method:'GET',path:'/api/auth/session'},exportInput={queryRequestId:'11111111-1111-4111-8111-111111111111',format:'csv',rowIndices:[0],suggestedName:'x.csv'};
  for(const [name,args]of [['request',[input]],['saveExport',[exportInput]],['close',[]]]){
    assert.deepEqual(JSON.parse(JSON.stringify(await bridge[name](...args))),reply);
    reply={ok:false,error:require('../host.cjs').safeError({code:'REQUEST_FAILED',uncertainOutcome:true})};
    assert.equal((await bridge[name](...args)).error.uncertainOutcome,true);
  }
});
test('I2 preload local validation and IPC rejection return fixed plain safe failures',async()=>{
  const {serializedBridge}=require('./serialized-bridge.cjs');const renderer=vm.createContext({window:{}});const calls=[];
  const bridge=serializedBridge(renderer,async(...args)=>{calls.push(args);throw Error('/private/key secret from Electron');});
  const circular={method:'POST',path:'/api/query',body:{}};circular.body.self=circular;
  for(const input of [{method:'GET',path:'/api/health',headers:{}},circular,{method:'POST',path:'/api/query',body:{sql:'x'.repeat(65537)}},{method:'POST',path:'/api/query',body:{sql:1n}}]){
    const invalid=await bridge.request(input);assert.equal(invalid.ok,false);assert.equal(invalid.error.code,'INVALID_REQUEST');assert.equal(invalid.error.uncertainOutcome,false);
  }
  assert.equal(calls.length,0);
  for(const [name,args]of [['request',[{method:'GET',path:'/api/health'}]],['saveExport',[{queryRequestId:'11111111-1111-4111-8111-111111111111',format:'csv',rowIndices:[],suggestedName:'x.csv'}]],['close',[]]]){
    const reply=await bridge[name](...args);assert.equal(reply.ok,false);assert.equal(reply.error.code,'REQUEST_FAILED');assert.equal(typeof reply.error.uncertainOutcome,'boolean');assert.doesNotMatch(JSON.stringify(reply),/\/private|secret|Electron/);
  }
});
test('I2 serialized data rejects malformed envelopes and renderer reconstructs only safe typed errors',async()=>{
  const {serializedBridge}=require('./serialized-bridge.cjs');const renderer=vm.createContext({window:{location:{protocol:'gridbase:',host:'app'},GridBaseSession:{mode:'local'}},Headers,TextEncoder});let reply;
  serializedBridge(renderer,async()=>reply);vm.runInContext(require('node:fs').readFileSync(path.join(__dirname,'../../public/runtime-transport.js'),'utf8'),renderer);
  const transport=renderer.window.GridBaseTransport;
  for(const value of [null,{ok:false,error:{code:'EVIL',message:'/secret',uncertainOutcome:true}},{ok:false,error:{code:'REQUEST_FAILED',message:'/secret',uncertainOutcome:'true'}},{ok:true,value:{status:200,headers:{authorization:'/secret'},body:'{}'}},{ok:true,value:{status:200,headers:{},body:'x'.repeat(16777217)}}]){
    reply=value;await assert.rejects(transport.request('/api/health'),error=>error.code==='REQUEST_FAILED'&&typeof error.uncertainOutcome==='boolean'&&!/secret/.test(error.message));
  }
  reply={ok:false,error:{code:'USER_CANCELLED',message:'/private/raw',uncertainOutcome:false}};await assert.rejects(transport.request('/api/health'),error=>error.code==='USER_CANCELLED'&&error.uncertainOutcome===false&&error.message==='Query cancelled. No SQL was sent.');
  reply={ok:true,value:{canceled:true}};assert.equal((await transport.saveExport({queryRequestId:'11111111-1111-4111-8111-111111111111',format:'csv',rowIndices:[],suggestedName:'x.csv'})).canceled,true);
  reply={ok:true,value:null};assert.equal(await transport.close(),null);
});
test('I2 startup Close consumes serialized envelope and hides raw IPC rejection',async()=>{
  const {serializedBridge}=require('./serialized-bridge.cjs');const nodes=new Map();const document={querySelector:selector=>{if(!nodes.has(selector))nodes.set(selector,{textContent:'',addEventListener(name,fn){this[name]=fn;}});return nodes.get(selector);}};
  const renderer=vm.createContext({window:{location:{protocol:'gridbase:',host:'app'}},document,Headers,TextEncoder});serializedBridge(renderer,async()=>{throw Error('/private/native secret');});
  vm.runInContext(require('node:fs').readFileSync(path.join(__dirname,'../../public/runtime-transport.js'),'utf8'),renderer);vm.runInContext(require('node:fs').readFileSync(path.join(__dirname,'../startup.js'),'utf8'),renderer);
  await document.querySelector('#startup-close').click();assert.match(document.querySelector('#startup-state').textContent,/could not close/);assert.doesNotMatch(document.querySelector('#startup-state').textContent,/\/private|secret/);
});
test('sandbox preload exposes only frozen typed facade, strips event objects and unsubscribes', async () => {
  let exposed, handler, removed; const calls = [];
  const ipcRenderer = { invoke: async (...args) => { calls.push(args); return { ok: true, value: { status: 200, headers:{}, body: '{}' } }; }, on: (channel, fn) => { handler = fn; }, removeListener: (channel, fn) => { removed = fn; } };
  vm.runInNewContext(require('node:fs').readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), { TextEncoder, require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'GridBaseNative'); exposed = value; } }, ipcRenderer }; } });
  assert.equal(Object.isFrozen(exposed), true); assert.deepEqual(Object.keys(exposed).sort(), ['close', 'onEngineState', 'request', 'saveExport']);
  await exposed.request({ method: 'GET', path: '/api/auth/session' }); assert.equal(calls[0][0], 'gridbase:request');
  let received; const off = exposed.onEngineState(value => { received = value; }); handler({ secret: true }, { state: 'stopped', message: '/secret', capability: 'never' }); assert.equal(JSON.stringify(received), '{"state":"stopped"}'); off(); assert.equal(removed, handler);
  assert.equal((await exposed.request({ method: 'GET', path: '/api/health', headers: {} })).error.code,'INVALID_REQUEST');
});
