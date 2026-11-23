'use strict';
// Genuine sandbox-enabled Electron + real Java/JDBC workflow. NOT part of unit
// gates, NOT executed on hosts whose Electron sandbox launch is known blocked.
// Run explicitly on an approved Ubuntu 24.04 x64 GUI runner with Java17, root
// npm test prerequisites and: GRIDBASE_DESKTOP_E2E=1 npm --prefix desktop run test:e2e
// Playwright 1.65.1 defaults Electron to --no-sandbox on Linux: the explicit
// chromiumSandbox:true below is mandatory. Never remove it to get a green run.
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {makeWorkflowBundle}=require('./workflow-fixture.cjs');const {_electron}=require('playwright');
const enabled=process.env.GRIDBASE_DESKTOP_E2E==='1';
test('sandboxed Electron offline local workflow, safe JSON, native confirmation/export, persistence and crash', {skip:!enabled?'NOT RUN: requires approved sandbox-capable native GUI runner (known host/VM exit133; no bypass permitted)':false,timeout:180000},async t=>{
  assert.equal(process.platform,'linux','Windows public start remains gated; this fixture does not activate it');assert.ok(process.env.DISPLAY,'A sandbox-capable native GUI display is required');
  const f=await makeWorkflowBundle(t),repo=path.resolve(__dirname,'../..');
  // Disposable trusted distribution: process.resourcesPath remains Electron's
  // real fixed resources directory. No application launch/path override exists.
  const runtime=path.join(f.root,'electron');await fs.cp(path.join(__dirname,'../node_modules/electron/dist'),runtime,{recursive:true,dereference:true});
  const resources=path.join(runtime,'resources');await fs.mkdir(resources,{recursive:true});await fs.cp(f.bundleDir,path.join(resources,'gridbase-engine'),{recursive:true});
  const appRoot=path.join(resources,'app');await fs.mkdir(appRoot);
  for(const dir of ['public','packages/local-engine','desktop'])await fs.cp(path.join(repo,dir),path.join(appRoot,dir),{recursive:true,filter:source=>!source.split(path.sep).includes('node_modules')&&!source.split(path.sep).includes('test')});
  await fs.writeFile(path.join(appRoot,'package.json'),JSON.stringify({name:'gridbase-e2e-distribution',version:'1.4.0',main:'test-entry.cjs'}));
  // Test-only trusted main bootstrap: install controlled native dialog service
  // answers before loading the unmodified production entry. Production has no
  // test channel/env/path override; actual GTK dialog interaction is separate
  // native acceptance, while this exercises Electron IPC/preload/DOM+real JVM.
  await fs.writeFile(path.join(appRoot,'test-entry.cjs'),`const {dialog}=require('electron');globalThis.fixtureDialogs=[];globalThis.fixtureSaves=[];dialog.showMessageBox=async(w,o)=>{o=o||w;fixtureDialogs.push(o);if(o.title==='Credential storage consent')return {response:1};return await new Promise(r=>{globalThis.fixtureResolve=r})};dialog.showSaveDialog=async(w,o)=>{fixtureSaves.push(o);return await new Promise(r=>{globalThis.fixtureSaveResolve=r})};
// Trusted fixture-only broker-response-to-host fault: one real JDBC request
// completes, then its response is lost. No production switch or IPC is added.
const {EngineClient}=require('./packages/local-engine');const request=EngineClient.prototype.request;globalThis.fixtureFaultCalls=0;EngineClient.prototype.request=async function(input){const response=await request.call(this,input);if(globalThis.fixtureQueryResponseFault&&input.method==='POST'&&input.path.split('?')[0]==='/api/query'){globalThis.fixtureQueryResponseFault=false;globalThis.fixtureFaultCalls++;throw Object.assign(new Error('fixture response lost'),{code:'REQUEST_FAILED',uncertainOutcome:true})}return response};require('./desktop/main.cjs');`);
  const config=path.join(f.root,'config'),home=path.join(f.root,'home');await fs.mkdir(config,{mode:0o700});await fs.mkdir(home,{mode:0o700});
  let app;const launch=async()=>{
    app=await _electron.launch({executablePath:path.join(runtime,'electron'),args:[appRoot],chromiumSandbox:true,timeout:30000,env:{DISPLAY:process.env.DISPLAY,HOME:home,XDG_CONFIG_HOME:config,XDG_CACHE_HOME:path.join(home,'cache'),TMPDIR:process.env.TMPDIR,LANG:'C.UTF-8',...(process.env.DBUS_SESSION_BUS_ADDRESS?{DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}:{})}});
    t.after(async()=>{if(app)await app.close().catch(()=>{});});
    const page=await app.firstWindow();const requests=[];page.on('request',r=>requests.push(r.url()));await page.waitForURL('gridbase://app/index.html');await page.locator('#app').waitFor({state:'visible'});
    assert.equal(requests.some(url=>/^https?:/.test(url)),false,'renderer startup must be entirely packaged/offline');assert.equal(await page.locator('#session-user').textContent(),'Local');
    assert.equal(await page.evaluate(()=>typeof require),'undefined');assert.equal(await page.evaluate(()=>Object.isFrozen(window.GridBaseNative)),true);
    const prefs=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
    return page;
  };
  let page=await launch();
  await page.locator('#add-connection').click();
  for(const [id,value]of Object.entries({'connection-name':'Fixture <b>inert</b>','connection-host':'fixture','connection-port':'5432','connection-database':'test','connection-username':'synthetic','connection-password':'synthetic-only'}))await page.locator('#'+id).fill(value);
  await page.locator('#connect-connection').click();await page.locator('#connection-dialog').waitFor({state:'hidden'});await page.getByRole('button',{name:'Toggle tables in Fixture <b>inert</b> / fixture',exact:true}).click();await page.getByRole('button',{name:'Show columns of Fixture <b>inert</b> / items',exact:true}).click();assert.ok((await page.locator('#schema-list').textContent()).includes('payload'));
  const run=async sql=>{await page.locator('#sql-editor').fill(sql);await page.locator('#run-query').click();};
  await run('SELECT payload FROM items;');await page.getByRole('button',{name:'Open row 1 detail',exact:true}).click();const detail=await page.locator('#row-detail-table-wrap').textContent();assert.ok(detail.includes('9007199254740993'));assert.ok(detail.includes('\n  "id":'));assert.equal(await page.locator('#row-detail img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);await page.locator('#close-row-detail').click();
  const writes=path.join(config,'GridBaseDesktop/engine-data/jdbc-writes');const before=await fs.readFile(writes,'utf8');
  const snapshot=()=>page.evaluate(()=>({result:document.querySelector('#results-table-wrap').textContent,output:document.querySelector('#query-output').textContent,history:localStorage.getItem('thrift-query-workbench:history:v1:'+window.GridBaseSession.user.id)}));
  const prior=await snapshot();const connectionId=await page.locator('#console-connection').inputValue();
  const cancel=async sql=>app.evaluate(async sql=>{while(!globalThis.fixtureResolve)await new Promise(r=>setTimeout(r,10));const last=fixtureDialogs.at(-1);if(!last.detail.endsWith(sql)||last.defaultId!==0||last.cancelId!==0)throw Error('wrong exact confirmation');fixtureResolve({response:0});fixtureResolve=null;},sql);
  for(const sql of ['UPDATE items SET x=2;','DELETE FROM items;']){
    const direct=page.evaluate(async({sql,connectionId})=>window.GridBaseNative.request({method:'POST',path:'/api/query',body:{sql,connectionId}}),{sql,connectionId});await cancel(sql);const envelope=await direct;
    assert.equal(envelope.ok,false);assert.equal(envelope.error.code,'USER_CANCELLED');assert.equal(envelope.error.uncertainOutcome,false);assert.equal(typeof envelope.error.message,'string');
    const typed=page.evaluate(async({sql,connectionId})=>{try{await window.GridBaseTransport.request('/api/query',{method:'POST',body:JSON.stringify({sql,connectionId})});return null;}catch(error){return {code:error.code,uncertainOutcome:error.uncertainOutcome};}},{sql,connectionId});await cancel(sql);assert.deepEqual(await typed,{code:'USER_CANCELLED',uncertainOutcome:false});
    const editor='SELECT 1;\n'+sql+'\nSELECT 2;';await page.locator('#sql-editor').fill(editor);await page.locator('#sql-editor').evaluate((e,sql)=>e.setSelectionRange(e.value.indexOf(sql),e.value.indexOf(sql)+sql.length),sql);await page.locator('#sql-editor').press('Control+Enter');await cancel(sql);await page.waitForFunction(()=>!document.querySelector('#run-query').disabled);
    assert.deepEqual(await snapshot(),prior,'cancel preserves prior displayed result/output/history');assert.equal(await fs.readFile(writes,'utf8'),before,'cancel produces zero JDBC submissions');
  }
  for(const sql of ['UPDATE items SET x=2;','DELETE FROM items WHERE x=2;']){
    await run(sql);await app.evaluate(async()=>{while(!globalThis.fixtureResolve)await new Promise(r=>setTimeout(r,10));fixtureResolve({response:1});fixtureResolve=null;});await page.waitForFunction(()=>!document.querySelector('#run-query').disabled);
  }
  for(const consumer of ['bridge','transport']){
    const priorFaultWrites=await fs.readFile(writes,'utf8');await app.evaluate(()=>{globalThis.fixtureQueryResponseFault=true;});
    const pending=page.evaluate(async({consumer,connectionId})=>{
      const input={method:'POST',path:'/api/query',body:{sql:'UPDATE items SET x=3;',connectionId}};
      if(consumer==='bridge')return window.GridBaseNative.request(input);
      try{await window.GridBaseTransport.request(input.path,{method:'POST',body:JSON.stringify(input.body)});return null;}catch(error){return {code:error.code,uncertainOutcome:error.uncertainOutcome};}
    },{consumer,connectionId});
    await app.evaluate(async()=>{while(!globalThis.fixtureResolve)await new Promise(r=>setTimeout(r,10));fixtureResolve({response:1});fixtureResolve=null;});const reply=await pending;
    if(consumer==='bridge'){assert.equal(reply.ok,false);assert.equal(reply.error.code,'REQUEST_FAILED');assert.equal(reply.error.uncertainOutcome,true);assert.match(reply.error.message,/check the database before retrying/i);}
    else assert.deepEqual(reply,{code:'REQUEST_FAILED',uncertainOutcome:true});
    assert.equal(await fs.readFile(writes,'utf8'),priorFaultWrites+'UPDATE items SET x=3\n','lost response has exactly one JDBC submission, no retry (Java removes the terminal semicolon)');
  }
  assert.equal(await app.evaluate(()=>globalThis.fixtureFaultCalls),2);
  await run('SELECT payload FROM items;');await page.waitForFunction(()=>!document.querySelector('#export-json').disabled);
  await page.locator('#export-json').click();await app.evaluate(async()=>{while(!globalThis.fixtureSaveResolve)await new Promise(r=>setTimeout(r,10));fixtureSaveResolve({canceled:true});fixtureSaveResolve=null;});await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Export cancelled.');
  const output=path.join(f.root,'chosen.json');await page.locator('#export-json').click();await app.evaluate(async output=>{while(!globalThis.fixtureSaveResolve)await new Promise(r=>setTimeout(r,10));fixtureSaveResolve({canceled:false,filePath:output});fixtureSaveResolve=null;},output);await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('exported'));assert.ok((await fs.readFile(output,'utf8')).includes('9007199254740993'));
  await page.locator('#activity-tool').click();await page.getByRole('button',{name:'Detail',exact:true}).first().waitFor();assert.ok((await page.locator('#activity-table').textContent()).includes('result.export_requested'));
  const logs=await page.evaluate(async()=>{const reply=await window.GridBaseNative.request({method:'GET',path:'/api/activity?scope=mine&limit=100'});if(!reply.ok)throw Error('Fixture audit lookup failed');return JSON.parse(reply.value.body);});assert.ok(logs.events.some(e=>e.sqlText==='UPDATE items SET x=2;'));assert.ok(logs.events.every(e=>e.source==='desktop'));
  const owner=await page.evaluate(()=>window.GridBaseSession.user.id);const exited=new Promise(resolve=>app.process().once('exit',resolve));await page.locator('#logout').click();await exited;app=null;
  page=await launch();assert.equal(await page.evaluate(()=>window.GridBaseSession.user.id),owner);assert.ok((await page.locator('#schema-list').textContent()).includes('Fixture <b>inert</b>'));assert.equal(await page.evaluate(()=>document.querySelector('#results-table-wrap').textContent),'');
  // Linux exact owned PID observed from this disposable host, never name/global kill.
  const pid=app.process().pid;const children=(await fs.readFile('/proc/'+pid+'/task/'+pid+'/children','utf8')).trim().split(/\s+/).filter(Boolean).map(Number);const java=[];for(const child of children){try{if((await fs.readlink('/proc/'+child+'/exe')).startsWith(resources+'/gridbase-engine/jre/'))java.push(child);}catch{}}
  assert.equal(java.length,1);process.kill(java[0],'SIGKILL');await page.waitForURL('gridbase://app/startup.html');await app.evaluate(async()=>{while(!globalThis.fixtureResolve)await new Promise(r=>setTimeout(r,10));fixtureResolve({response:0});fixtureResolve=null;});
});
