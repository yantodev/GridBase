'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events'); const path = require('node:path');
const { createApplication, startupMessage } = require('../application.cjs');

function fixture() {
  const app = new EventEmitter(); Object.assign(app, { quitCount: 0, quit() { this.quitCount++; }, getAppPath: () => '/installed/app', isPackaged: true });
  const calls = [], handles = {}; let stops = 0, exit, keyCalls = 0, failKey = false, choices = [];
  class Window extends EventEmitter { constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: 'gridbase://app/startup.html' }; this.webContents.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, webRequest: { onBeforeRequest() {} } }; this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = (...args) => calls.push(args); } async loadURL(url) { this.webContents.mainFrame.url = url; calls.push(url); } show() {} isMinimized() { return true; } restore() { calls.push('restore'); } focus() { calls.push('focus'); } }
  const client = { request: async () => ({ status: 200, headers: {}, body: '{}' }), onExit: fn => { exit = fn; return () => {}; }, stop: async () => { stops++; } };
  const electron = { app, BrowserWindow: Window, ipcMain: { handle: (name, fn) => { handles[name] = fn; } }, dialog: { showMessageBox: async (w, options) => { calls.push(options); return { response: choices.shift() ?? 0 }; } } };
  const application = createApplication(electron, { paths: { dataDir: '/private/data', tempDir: '/private/temp' }, bundleDir: '/installed/resources/gridbase-engine',
    EngineClient: { start: async options => { calls.push(options); return client; } }, loadOrCreateKey: async (dir, options) => { keyCalls++; calls.push(options); if (failKey && !options.allowPlaintextFallback) throw Object.assign(Error(), { code: 'FALLBACK_CONSENT_REQUIRED' }); return Buffer.alloc(32, 7); } });
  return { application, app, calls, handles, crash: () => exit({ code: 1, signal: null }), stops: () => stops, keyCalls: () => keyCalls, failKey: () => { failKey = true; }, choices: value => { choices = value; } };
}
test('main owns single engine through window lifecycle, focuses second instance and waits idempotent stop on quit', async () => {
  const f = fixture(); await f.application.start(); assert.ok(f.calls.includes('gridbase://app/index.html'));
  const options = f.calls.find(value => value?.clientKind === 'desktop'); assert.equal(options.bundleDir, '/installed/resources/gridbase-engine'); assert.equal(options.credentialKey.every(byte => byte === 0), true);
  f.app.emit('second-instance'); assert.ok(f.calls.includes('focus'));
  let prevented = 0; f.app.emit('before-quit', { preventDefault() { prevented++; } }); f.app.emit('before-quit', { preventDefault() { prevented++; } }); await new Promise(setImmediate);
  assert.equal(prevented, 2); assert.equal(f.stops(), 1); assert.equal(f.app.quitCount, 1);
});
test('fallback consent is main-native, cancel creates no key and affirmative alone authorizes fallback', async () => {
  const f = fixture(); f.failKey(); f.choices([0, 0]); await f.application.start(); assert.equal(f.keyCalls(), 1); assert.equal(f.calls.some(v => v?.clientKind), false);
  const g = fixture(); g.failKey(); g.choices([1]); await g.application.start(); assert.equal(g.keyCalls(), 2); assert.deepEqual(g.calls.filter(v => Object.hasOwn(v || {}, 'allowPlaintextFallback')), [{ allowPlaintextFallback: false }, { allowPlaintextFallback: true }]);
});
test('quit during engine startup waits for owned launch and then stops it before app quit',async()=>{
  const app=new EventEmitter();let quit=0,finish,stops=0;Object.assign(app,{getAppPath:()=>'/installed/app',isPackaged:true,quit(){quit++;}});
  class Window extends EventEmitter{constructor(){super();this.webContents=new EventEmitter();this.webContents.send=()=>{};this.webContents.setWindowOpenHandler=()=>{};this.webContents.session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){},webRequest:{onBeforeRequest(){}}};}async loadURL(){}show(){}}
  const pending=new Promise(resolve=>{finish=resolve;});const application=createApplication({app,BrowserWindow:Window,dialog:{},ipcMain:{handle(){}}},{paths:{dataDir:'/private/data',tempDir:'/private/temp'},bundleDir:'/installed/gridbase-engine',EngineClient:{start:()=>pending},loadOrCreateKey:async()=>Buffer.alloc(32)});
  const starting=application.start();await new Promise(setImmediate);const quitting=application.quit();await new Promise(setImmediate);assert.equal(quit,0);finish({stop:async()=>{stops++;}});await starting;await quitting;assert.equal(stops,1);assert.equal(quit,1);
});
for(const replacement of ['success','failure'])test('I3 retry close joins replacement launch '+replacement+' instead of previous stop',async()=>{
  const app=new EventEmitter();let quits=0,launches=0,firstStops=0,nextStops=0,finish,reject,finishStop;const keys=[];
  Object.assign(app,{getAppPath:()=>'/installed/app',isPackaged:true,quit(){quits++;}});
  class Window extends EventEmitter{constructor(){super();this.webContents=new EventEmitter();this.webContents.send=()=>{};this.webContents.setWindowOpenHandler=()=>{};this.webContents.session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){},webRequest:{onBeforeRequest(){}}};}async loadURL(url){if(url==='gridbase://app/index.html')throw Error('first post-start workbench load failed');}show(){}}
  const pending=new Promise((resolve,rejecter)=>{finish=resolve;reject=rejecter;}),stopPending=new Promise(resolve=>{finishStop=resolve;});
  const application=createApplication({app,BrowserWindow:Window,dialog:{showMessageBox:async()=>({response:1})},ipcMain:{handle(){}}},{paths:{dataDir:'/private/data',tempDir:'/private/temp'},bundleDir:'/installed/gridbase-engine',
    EngineClient:{start:async()=>{launches++;if(launches===1)return {onExit:()=>()=>{},stop:async()=>{firstStops++;}};return pending;}},loadOrCreateKey:async()=>{const key=Buffer.alloc(32,7);keys.push(key);return key;}});
  const starting=application.start();for(let i=0;i<4;i++)await new Promise(setImmediate);assert.equal(launches,2);assert.equal(firstStops,1);
  const quitting=application.quit(),again=application.quit();app.emit('before-quit',{preventDefault(){}});await new Promise(setImmediate);
  const earlyQuit=quits;
  if(replacement==='success')finish({stop:async()=>{nextStops++;await stopPending;}});else reject(Error('replacement failed safely'));
  for(let i=0;i<3;i++)await new Promise(setImmediate);
  let repeatedFinished=false;again.then(()=>{repeatedFinished=true;});await new Promise(setImmediate);const repeatedBeforeStop=repeatedFinished;
  const quitBeforeStop=quits;finishStop();await starting;await quitting;await again;
  if(replacement==='success')assert.equal(repeatedBeforeStop,false,'every repeated quit must join the owned stop');
  assert.equal(earlyQuit,0,'quit must await replacement even after previous teardown');assert.equal(firstStops,1);assert.equal(nextStops,replacement==='success'?1:0);if(replacement==='success')assert.equal(quitBeforeStop,0,'quit must await actual replacement stop');assert.equal(quits,1);assert.equal(keys.every(key=>key.every(byte=>byte===0)),true);
});
test('I3 first failed launch is joined by repeated quit without an owned stop',async()=>{
  const app=new EventEmitter();let quits=0,reject;Object.assign(app,{getAppPath:()=>'/installed/app',isPackaged:true,quit(){quits++;}});
  class Window extends EventEmitter{constructor(){super();this.webContents=new EventEmitter();this.webContents.send=()=>{};this.webContents.setWindowOpenHandler=()=>{};this.webContents.session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){},webRequest:{onBeforeRequest(){}}};}async loadURL(){}show(){}}
  const pending=new Promise((resolve,no)=>{reject=no;});const application=createApplication({app,BrowserWindow:Window,dialog:{showMessageBox:()=>assert.fail()},ipcMain:{handle(){}}},{paths:{dataDir:'/private/data',tempDir:'/private/temp'},bundleDir:'/installed/gridbase-engine',EngineClient:{start:()=>pending},loadOrCreateKey:async()=>Buffer.alloc(32)});
  const starting=application.start();await new Promise(setImmediate);const quitting=application.quit();void application.quit();await new Promise(setImmediate);assert.equal(quits,0);reject(Error('launch failed'));await starting;await quitting;assert.equal(quits,1);
});
test('engine crash conceals old page, clears host results and never restarts or replays SQL automatically', async () => {
  const f = fixture(); await f.application.start(); f.choices([0]); f.crash(); await new Promise(setImmediate);
  assert.ok(f.calls.includes('gridbase://app/startup.html')); assert.equal(f.calls.filter(v => v?.clientKind).length, 1); assert.equal(f.app.quitCount, 1);
  assert.match(startupMessage({ code: 'WINDOWS_PRIVATE_STORAGE_UNSUPPORTED' }), /Windows.*not.*verified/i);
  assert.doesNotMatch(startupMessage({ message: '/private/key secret' }), /\/private\/key|secret/);
});
