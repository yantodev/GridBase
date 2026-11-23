'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const vm=require('node:vm');
const {makeWorkflowBundle}=require('./workflow-fixture.cjs');
const {EngineClient}=require('../../packages/local-engine');const {createHost}=require('../host.cjs');
test('real isolated Java/JDBC through desktop host covers metadata, confirmation, audit/export and persisted profile', {timeout:60000},async t=>{
  const f=await makeWorkflowBundle(t);const {root:ignored,...options}=f;const client=await EngineClient.start(options);t.after(()=>client.stop());
  const frame={url:'gridbase://app/index.html'},contents={mainFrame:frame},event={sender:contents,senderFrame:frame};let approve=0,chosen={canceled:true},dropQueryResponse=false;const saves=[],dialogs=[];
  const host=createHost({getWindow:()=>({webContents:contents}),dialog:{showMessageBox:async(w,options)=>{dialogs.push(options);return {response:approve};},showSaveDialog:async()=>{saves.push(true);return chosen;}},writeFile:fs.writeFile});
  // Named fixture-only fault after real JDBC/HTTP completes and before host
  // receives the broker response. Business requests always use the real engine.
  host.setEngine({request:async input=>{const response=await client.request(input);if(dropQueryResponse&&input.path==='/api/query'){dropQueryResponse=false;throw Object.assign(Error('/private/fixture-response-lost'),{code:'REQUEST_FAILED',uncertainOutcome:true});}return response;}});
  const call=async(method,path,body)=>{const reply=await host.request(event,{method,path,...(body?{body}:{})});assert.equal(reply.ok,true,JSON.stringify(reply));assert.equal(reply.value.status,200,reply.value.body);return JSON.parse(reply.value.body);};
  const session=await call('GET','/api/auth/session');assert.equal(session.user.provider,'local');assert.equal(session.capabilities.auditAdmin,false);
  const renderer=vm.createContext({window:{location:{protocol:'gridbase:',host:'app'},GridBaseSession:{mode:'local'}},Headers,TextEncoder});
  require('./serialized-bridge.cjs').serializedBridge(renderer,(channel,input)=>channel==='gridbase:request'?host.request(event,input):channel==='gridbase:export'?host.saveExport(event,input):{ok:true,value:null});
  vm.runInContext(require('node:fs').readFileSync(require('node:path').join(__dirname,'../../public/runtime-transport.js'),'utf8'),renderer);const transport=renderer.window.GridBaseTransport;
  const profile={connectionId:'fixture',type:'postgresql',name:'<b>Fixture</b>',jdbcUrl:'jdbc:postgresql://fixture/test',username:'synthetic',password:'synthetic-only'};
  await call('POST','/api/connections/connect',profile);
  assert.deepEqual((await call('GET','/api/databases?connectionId=fixture')).databases,['fixture']);assert.deepEqual((await call('GET','/api/tables?connectionId=fixture&namespace=fixture')).tables,['items']);assert.equal((await call('GET','/api/columns?connectionId=fixture&namespace=fixture&table=items')).columns[0].name,'payload');
  const result=await call('POST','/api/query',{sql:'SELECT payload FROM items',connectionId:'fixture'});assert.ok(result.rows[0].payload.includes('9007199254740993'));
  const cancelled=await host.request(event,{method:'POST',path:'/api/query',body:{sql:'DELETE FROM items',connectionId:'fixture'}});assert.equal(cancelled.error.code,'USER_CANCELLED');
  const priorWrites=await fs.readFile(f.dataDir+'/jdbc-writes','utf8');
  for(const operation of ['UPDATE items SET x=2','DELETE FROM items'])for(const route of ['/api/query','/api/query?']){
    const sql='-- note\r'+operation,count=dialogs.length;
    const reply=await host.request(event,{method:'POST',path:route,body:{sql,connectionId:'fixture'}});
    assert.equal(reply.error?.code,'USER_CANCELLED','I1 real JDBC CR comment must not bypass confirmation');assert.equal(dialogs.length,count+1);assert.ok(dialogs.at(-1).detail.endsWith(sql));assert.equal(await fs.readFile(f.dataDir+'/jdbc-writes','utf8'),priorWrites);
    await assert.rejects(transport.request(route,{method:'POST',body:JSON.stringify({sql,connectionId:'fixture'})}),error=>error.code==='USER_CANCELLED'&&error.uncertainOutcome===false);assert.equal(dialogs.length,count+2);assert.equal(await fs.readFile(f.dataDir+'/jdbc-writes','utf8'),priorWrites);
  }
  approve=1;await call('POST','/api/query',{sql:'UPDATE items SET x=2',connectionId:'fixture'});
  const beforeUncertain=await fs.readFile(f.dataDir+'/jdbc-writes','utf8');dropQueryResponse=true;
  await assert.rejects(transport.request('/api/query',{method:'POST',body:JSON.stringify({sql:'UPDATE items SET x=3;',connectionId:'fixture'})}),error=>error.code==='REQUEST_FAILED'&&error.uncertainOutcome===true&&/check the database before retrying/i.test(error.message)&&!error.message.includes('/private'));
  assert.equal(await fs.readFile(f.dataDir+'/jdbc-writes','utf8'),beforeUncertain+'UPDATE items SET x=3\n','one JDBC submission despite uncertain response');
  const exported=await transport.saveExport({queryRequestId:result.requestId,format:'json',rowIndices:[0],suggestedName:'fixture.json'});assert.equal(exported.canceled,true);assert.equal(saves.length,1);
  const output=f.root+'/chosen.json';await assert.rejects(fs.stat(output));chosen={canceled:false,filePath:output};
  const saved=await transport.saveExport({queryRequestId:result.requestId,format:'json',rowIndices:[0],suggestedName:'fixture.json'});assert.equal(saved.canceled,false);assert.equal(await fs.readFile(output,'utf8'),JSON.stringify(result.rows,null,2));
  assert.equal((await fs.stat(output)).mode&0o777,0o600);
  const logs=await call('GET','/api/activity?scope=mine&limit=100');assert.equal(logs.events.filter(e=>e.action==='result.export_requested').length,2);assert.ok(logs.events.some(e=>e.sqlText==='UPDATE items SET x=2'));assert.ok(logs.events.every(e=>e.source==='desktop'));
  assert.equal((await fs.readFile(f.dataDir+'/jdbc-writes','utf8')).trim().split('\n').length,3);await client.stop();
  const reopened=await EngineClient.start(options);try{const profiles=JSON.parse((await reopened.request({method:'GET',path:'/api/connections'})).body);assert.equal(profiles.connections[0].name,'<b>Fixture</b>');assert.equal(profiles.connections[0].connected,false);}finally{await reopened.stop();}
});
