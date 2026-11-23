'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createHost } = require('../host.cjs');
const ID = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const calls = [], dialogs = [], writes = []; let answer = { response: 0 }, save = { canceled: true }, reply;
  const frame = { url: 'gridbase://app/index.html' }, contents = { mainFrame: frame }, window = { webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  const client = { async request(request) { calls.push(request); if (reply) return reply(request); return { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': ID }, body: JSON.stringify(request.path === '/api/connections' ? { connections: [{ id: 'db', name: '<b>Orders</b>' }], defaultConnectionId: 'db' } : request.path === '/api/query' ? { requestId: ID, columns: ['value'], rows: [{ value: '<img onerror=host()>' }, { value: 'two' }] } : { ok: true }) }; } };
  const host = createHost({ getWindow: () => window, dialog: { async showMessageBox(w, options) { dialogs.push(options); return await answer; }, async showSaveDialog(w, options) { dialogs.push(options); return save; } }, writeFile: async (...args) => writes.push(args) });
  host.setEngine(client);
  return { host, event, calls, dialogs, writes, frame, contents, setAnswer: value => { answer = value; }, setSave: value => { save = value; }, setReply: value => { reply = value; } };
}
const query = sql => ({ method: 'POST', path: '/api/query', body: { sql, connectionId: 'db' } });
test('host refuses foreign sender, subframe, wrong origin and unknown fields before dispatch', async () => {
  const f = fixture();
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: { url: f.frame.url } }, { ...f.event, senderFrame: null }]) assert.equal((await f.host.request(event, query('SELECT 1'))).error.code, 'INVALID_SENDER');
  for (const url of ['https://app/index.html', 'gridbase://app.evil/index.html', 'gridbase://app/index.html?x', 'gridbase://app/startup.html']) { f.frame.url = url; assert.equal((await f.host.request(f.event, query('SELECT 1'))).ok, false); }
  f.frame.url = 'gridbase://app/index.html';
  for (const payload of [{ ...query('SELECT 1'), headers: {} }, { ...query('SELECT 1'), signal: {} }, query('x'.repeat(20001)), { method: 'GET', path: 'http://localhost/api/connections' }]) assert.equal((await f.host.request(f.event, payload)).error.code, 'INVALID_REQUEST');
  assert.equal(f.calls.length, 0);
});
for(const sql of [
  'WITH RECURSIVE c(id) AS (SELECT 1) SEARCH DEPTH FIRST BY id SET ordering DELETE FROM t;',
  'WITH RECURSIVE c(id) AS (SELECT 1) CYCLE id SET is_cycle USING path UPDATE t SET x=2;',
  'WITH c AS (SELECT $$($$) DELETE FROM t;',
  'EXPLAIN ANALYSE DELETE FROM t;',
  '/* UPDATE in comment */ DELETE FROM t WHERE x=\'UPDATE\';'
])test('trusted main classifies mutation without renderer Boolean: '+sql.slice(0,40),async()=>{
  const f=fixture();assert.equal((await f.host.request(f.event,query(sql))).error.code,'USER_CANCELLED');assert.equal(f.calls.filter(r=>r.path==='/api/query').length,0);assert.ok(f.dialogs[0].detail.endsWith(sql));
});
for(const operation of ['UPDATE items SET x=2','DELETE FROM items'])test('I1 CR comment boundary confirms exact '+operation,async()=>{
  for(const ending of ['\r','\r\n','\n'])for(const route of ['/api/query','/api/query?']){
    const f=fixture(),sql='-- note'+ending+operation;
    const input={...query(sql),path:route};const cancelled=await f.host.request(f.event,input);
    assert.equal(cancelled.error?.code,'USER_CANCELLED',JSON.stringify({ending,route,cancelled}));assert.equal(f.dialogs.length,1);assert.ok(f.dialogs[0].detail.endsWith(sql));assert.equal(f.calls.filter(r=>r.path.startsWith('/api/query')).length,0);
    f.setAnswer({response:1});const approved=await f.host.request(f.event,input);assert.equal(approved.ok,true);assert.equal(JSON.parse(f.calls.at(-1).body).sql,sql);assert.equal(JSON.parse(f.calls.at(-1).body).connectionId,'db');
  }
});
test('I1 CR in quoted text keeps its exact business SQL without a mutation false positive',async()=>{
  const f=fixture(),sql="SELECT 'before\rafter DELETE', \"UPDATE\" /* comment\rDELETE */";assert.equal((await f.host.request(f.event,query(sql))).ok,true);assert.equal(f.dialogs.length,0);assert.equal(JSON.parse(f.calls[0].body).sql,sql);
});
test('quoted/comment mutation words in SELECT do not trigger native dialog',async()=>{const f=fixture();assert.equal((await f.host.request(f.event,query("SELECT 'DELETE', \"UPDATE\" /* DELETE */"))).ok,true);assert.equal(f.dialogs.length,0);});
test('native mutation defaults to Cancel with exact validated SQL and trusted connection; cancellation sends no SQL', async () => {
  const f = fixture(), sql = '/* selected */ WITH r AS (DELETE FROM t RETURNING *) SELECT * FROM r;';
  const result = await f.host.request(f.event, query(sql));
  assert.equal(result.error.code, 'USER_CANCELLED'); assert.equal(f.calls.filter(r => r.path === '/api/query').length, 0);
  assert.equal(f.dialogs[0].defaultId, 0); assert.equal(f.dialogs[0].cancelId, 0); assert.deepEqual(f.dialogs[0].buttons, ['Cancel', 'Run']);
  assert.ok(f.dialogs[0].detail.includes(sql)); assert.ok(f.dialogs[0].detail.includes('db')); assert.ok(f.dialogs[0].detail.includes('<b>Orders</b>'));
});
test('empty query suffix cannot bypass mutation confirmation or host-only export auditing',async()=>{
  const f=fixture();const input={...query('DELETE FROM t'),path:'/api/query?'};const result=await f.host.request(f.event,input);assert.equal(result.error.code,'USER_CANCELLED');assert.equal(f.calls.filter(r=>r.path.startsWith('/api/query')).length,0);
  assert.equal((await f.host.request(f.event,{method:'POST',path:'/api/activity/exports?',body:{queryRequestId:ID,format:'csv',rowCount:0}})).ok,false);
});
test('approval pins SQL and connection, refuses concurrent forged queries, and never replays a write', async () => {
  const f = fixture(); let approve; f.setAnswer(new Promise(resolve => { approve = resolve; }));
  const input = query('UPDATE t SET x=2'), pending = f.host.request(f.event, input);
  await new Promise(setImmediate); input.body.sql = 'DELETE FROM other'; input.body.connectionId = 'other';
  assert.equal((await f.host.request(f.event, query('DELETE FROM t'))).error.code, 'BUSY');
  approve({ response: 1 }); assert.equal((await pending).ok, true);
  const submitted = f.calls.filter(r => r.path === '/api/query'); assert.equal(submitted.length, 1); assert.deepEqual(JSON.parse(submitted[0].body), { sql: 'UPDATE t SET x=2', connectionId: 'db' });
});
test('backend generation change during dialog cancels, and uncertain transport errors remain safe without retry', async () => {
  const f = fixture(); let approve; f.setAnswer(new Promise(resolve => { approve = resolve; }));
  const pending = f.host.request(f.event, query('DELETE FROM t')); await new Promise(setImmediate); f.host.clearEngine(); approve({ response: 1 });
  assert.equal((await pending).ok, false); assert.equal(f.calls.filter(r => r.path === '/api/query').length, 0);
  const g = fixture(); g.setReply(async () => { throw Object.assign(new Error('/secret/raw'), { code: 'REQUEST_FAILED', uncertainOutcome: true }); });
  const result = await g.host.request(g.event, query('SELECT 1')); assert.equal(result.error.uncertainOutcome, true); assert.doesNotMatch(JSON.stringify(result), /secret|raw/); assert.equal(g.calls.length, 1);
});
test('host-owned export audits exactly once before dialog; renderer selects indices, not data or paths', async () => {
  const f = fixture(); await f.host.request(f.event, query('SELECT 1')); f.setSave({ canceled: false, filePath: '/chosen/export.json' });
  const result = await f.host.saveExport(f.event, { queryRequestId: ID, format: 'json', rowIndices: [1, 0], suggestedName: 'result.json' });
  assert.equal(result.ok, true); assert.equal(f.calls.filter(r => r.path === '/api/activity/exports').length, 1);
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { queryRequestId: ID, format: 'json', rowCount: 2 });
  assert.equal(f.writes[0][0], '/chosen/export.json'); assert.equal(f.writes[0][1], JSON.stringify([{ value: 'two' }, { value: '<img onerror=host()>' }], null, 2));
  for (const extra of [{ path: '/evil' }, { audited: true }, { rows: [] }]) assert.equal((await f.host.saveExport(f.event, { queryRequestId: ID, format: 'json', rowIndices: [0], suggestedName: 'x.json', ...extra })).ok, false);
});
test('pending confirmation also blocks connection retargeting and rejects renderer export audit authority', async () => {
  const f=fixture();let approve;f.setAnswer(new Promise(resolve=>{approve=resolve;}));const pending=f.host.request(f.event,query('UPDATE t SET x=2'));await new Promise(setImmediate);
  assert.equal((await f.host.request(f.event,{method:'DELETE',path:'/api/connections/db'})).error.code,'BUSY');
  assert.equal((await f.host.request(f.event,{method:'POST',path:'/api/activity/exports',body:{queryRequestId:ID,format:'csv',rowCount:1}})).ok,false);approve({response:0});await pending;
});
test('engine generation loss after submission preserves uncertain write outcome',async()=>{
  const f=fixture();let finish;f.setReply(()=>new Promise(resolve=>{finish=resolve;}));const pending=f.host.request(f.event,query('SELECT 1'));f.host.clearEngine();finish({status:200,headers:{},body:'{}'});const result=await pending;assert.equal(result.error.uncertainOutcome,true);
});
test('completed malformed or oversized submitted responses keep uncertain outcome and bounded safe envelope',async()=>{
  for(const body of ['not json','x'.repeat(16777217)]){const f=fixture();f.setReply(async()=>({status:200,headers:{},body}));const result=await f.host.request(f.event,query('SELECT 1'));assert.equal(result.ok,false);assert.equal(result.error.uncertainOutcome,true);assert.equal(f.calls.length,1);}
});
test('a pending connection replacement blocks queries until its exact request completes',async()=>{
  const f=fixture();let finish;f.setReply(()=>new Promise(resolve=>{finish=resolve;}));const pending=f.host.request(f.event,{method:'POST',path:'/api/connections',body:{type:'postgresql',connectionId:'db',name:'changed'}});
  assert.equal((await f.host.request(f.event,query('UPDATE t SET x=2'))).error.code,'BUSY');finish({status:200,headers:{},body:'{"ok":true}'});await pending;
});
test('export audit completes before dialog',async()=>{
  const f=fixture();await f.host.request(f.event,query('SELECT 1'));let audited,finish;f.setReply(request=>{assert.equal(request.path,'/api/activity/exports');return new Promise(resolve=>{finish=()=>{audited=true;resolve({status:200,headers:{},body:'{"ok":true}'});};});});
  const payload={queryRequestId:ID,format:'json',rowIndices:[1],suggestedName:'x.json'};const pending=f.host.saveExport(f.event,payload);await new Promise(setImmediate);assert.equal(f.dialogs.length,0);finish();await pending;assert.equal(audited,true);assert.equal(f.dialogs.length,1);
});
test('five-result and aggregate byte eviction retain no renderer data authority',async()=>{
  const f=fixture();let n=0;f.setReply(async()=>({status:200,headers:{},body:JSON.stringify({requestId:'11111111-1111-4111-8111-'+String(++n).padStart(12,'0'),columns:['value'],rows:[{value:'x'.repeat(3500000)}]})}));
  for(let i=0;i<6;i++)assert.equal((await f.host.request(f.event,query('SELECT 1'))).ok,true);
  const payload={queryRequestId:'11111111-1111-4111-8111-000000000001',format:'csv',rowIndices:[0],suggestedName:'x.csv'};assert.equal((await f.host.saveExport(f.event,payload)).error.code,'RESULT_EXPIRED');
});
test('export cancel writes nothing, audit warning/failure blocks dialog, expired results and invalid indices fail closed', async () => {
  const f = fixture(); await f.host.request(f.event, query('SELECT 1'));
  const payload = { queryRequestId: ID, format: 'csv', rowIndices: [0], suggestedName: 'x.csv' };
  assert.equal((await f.host.saveExport(f.event, payload)).value.canceled, true); assert.equal(f.writes.length, 0);
  for (const rowIndices of [[-1], [2], [0, 0], [0.1]]) assert.equal((await f.host.saveExport(f.event, { ...payload, rowIndices })).ok, false);
  for (const suggestedName of ['../x', 'a\\b', 'x\n', '.']) assert.equal((await f.host.saveExport(f.event, { ...payload, suggestedName })).ok, false);
  const before = f.dialogs.length; f.setReply(async () => ({ status: 200, headers: { 'x-gridbase-audit-warning': 'incomplete' }, body: '{"ok":true}' }));
  assert.equal((await f.host.saveExport(f.event, payload)).error.code, 'EXPORT_AUDIT_FAILED'); assert.equal(f.dialogs.length, before);
  f.host.clearEngine(); assert.equal((await f.host.saveExport(f.event, payload)).ok, false);
});
