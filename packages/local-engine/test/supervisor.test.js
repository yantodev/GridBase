'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const path = require('node:path'); const http = require('node:http');
const { fixture, options, waitFile } = require('./fixture.cjs');
test('owned child authenticates, scrubs env, uses fixed argv and safe HTTP facade', async t => {
  const { EngineClient } = require('..'); const f = await fixture(t); const prior = process.env.JAVA_TOOL_OPTIONS;
  process.env.JAVA_TOOL_OPTIONS = '-Dsecret=fixture'; t.after(() => { if (prior === undefined) delete process.env.JAVA_TOOL_OPTIONS; else process.env.JAVA_TOOL_OPTIONS = prior; });
  const client = await EngineClient.start(options(f)); t.after(() => client.stop());
  assert.deepEqual(Object.keys(client), []); assert.equal(client.capability, undefined); assert.equal(client.child, undefined);
  const result = await client.request({ method: 'GET', path: '/api/connections' }); assert.equal(result.status, 200);
  const body = JSON.parse(result.body); assert(!body.env.includes('JAVA_TOOL_OPTIONS')); assert(!body.env.includes('PATH')); assert(!body.env.includes('NODE_OPTIONS')); assert(!body.env.includes('CLASSPATH'));
  assert.equal(body.cwd, f.dataDir); assert(body.argv.includes('com.peentar.thriftquery.LocalEngineMain')); assert.equal(body.account, 'local:12345678-1234-1234-1234-123456789abc');
  assert.deepEqual(Object.keys(result.headers).sort(), ['content-type','x-request-id']); assert(!JSON.stringify(result).includes('transport-secret'));
  const exits = []; const unsubscribe = client.onExit(e => { exits.push(e); });
  await Promise.all([client.stop(), client.stop()]); assert.equal(exits.length, 1); assert.deepEqual(Object.keys(exits[0]).sort(), ['code','signal']); unsubscribe(); await client.stop();
  await assert.rejects(client.request({ method: 'GET', path: '/healthz' }), { code: 'ENGINE_EXITED' });
});
test('public request always rejects asynchronously and pre-aborted writes are not uncertain', async t => {
  const { EngineClient } = require('..'); const f = await fixture(t); const client = await EngineClient.start(options(f));
  try {
    await assert.rejects(client.request({ method: 'GET', path: '/healthz', headers: { Authorization: 'forged' } }), { code: 'INVALID_REQUEST' });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client.request({ method: 'POST', path: '/api/query', body: { sql: 'UPDATE fixture SET x=1' }, signal: controller.signal }), e => e.code === 'REQUEST_ABORTED' && !e.uncertainOutcome);
    assert.equal((await client.request({ method: 'GET', path: '/api/connections' })).status, 200);
    await assert.rejects(fs.readFile(path.join(f.dataDir, 'writes')), { code: 'ENOENT' });
  } finally { await client.stop(); }
});
test('invalid readiness, owned PID/version and authentication are rejected without raw diagnostics', async t => {
  const { EngineClient } = require('..');
  for (const mode of ['exit','malformed','oversize','protocol','pid','version','extra','bad-health','admin']) {
    const f = await fixture(t, mode);
    await assert.rejects(EngineClient.start(options(f)), e => { assert(!String(e).includes(f.root)); assert(!String(e).includes('synthetic-secret')); return ['START_FAILED','INVALID_READY','AUTH_FAILED','ENGINE_EXITED'].includes(e.code); });
    const pid = +(await fs.readFile(path.join(f.dataDir, 'child.pid'), 'utf8')); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});
test('redirect never contacts another listener and response bounds do not truncate', async t => {
  const { EngineClient } = require('..'); let contacts = 0; const server = http.createServer((req, res) => { contacts++; res.end('{}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  for (const [mode, code] of [['redirect','REDIRECT_DENIED'],['large','RESPONSE_TOO_LARGE'],['reflect','REQUEST_FAILED']]) {
    const f = await fixture(t, mode, server.address().port); const client = await EngineClient.start(options(f));
    try { await assert.rejects(client.request({ method: 'GET', path: '/api/connections' }), { code }); } finally { await client.stop(); }
  }
  assert.equal(contacts, 0);
});
test('dropped or exited submitted write is uncertain and never retried', async t => {
  const { EngineClient } = require('..');
  for (const mode of ['drop-write','exit-write','hang-write']) {
    const f = await fixture(t, mode); const client = await EngineClient.start(options(f));
    const controller = new AbortController();
    const request = client.request({ method: 'POST', path: '/api/query', body: { sql: 'UPDATE fixture SET x=1' }, signal: controller.signal });
    const checked = assert.rejects(request, e => e.uncertainOutcome === true && ['REQUEST_FAILED','REQUEST_ABORTED','ENGINE_EXITED'].includes(e.code));
    await waitFile(path.join(f.dataDir, 'writes')); if (mode === 'hang-write') controller.abort(); await checked;
    assert.equal((await fs.readFile(path.join(f.dataDir, 'writes'), 'utf8')).trim().split('\n').length, 1); await client.stop();
  }
});
test('startup timeout and five second EOF deadline kill only the owned process', { timeout: 45000 }, async t => {
  const { EngineClient } = require('..'); const f = await fixture(t, 'no-ready'); const start = Date.now();
  await assert.rejects(EngineClient.start(options(f)), { code: 'START_TIMEOUT' }); assert(Date.now() - start >= 29000);
  const stubborn = await fixture(t, 'ignore-eof'); const client = await EngineClient.start(options(stubborn)); const before = Date.now(); await client.stop(); assert(Date.now() - before >= 4900);
  const pid = +(await fs.readFile(path.join(stubborn.dataDir, 'child.pid'), 'utf8')); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('spawn error is redacted and request timeout makes a submitted write uncertain exactly once', { timeout: 40000 }, async t => {
  const { EngineClient } = require('..'); const { writeManifest } = require('./fixture.cjs');
  const bad = await fixture(t); await fs.writeFile(path.join(bad.bundleDir, 'java fixture 空'), '#!/nonexistent/task5-java\n'); await writeManifest(bad.bundleDir, 'java fixture 空');
  await assert.rejects(EngineClient.start(options(bad)), e => ['START_FAILED','ENGINE_EXITED'].includes(e.code) && !String(e).includes('nonexistent'));
  const f = await fixture(t, 'hang-write'); const client = await EngineClient.start(options(f));
  try { await assert.rejects(client.request({ method: 'POST', path: '/api/query', body: { sql: 'UPDATE fixture SET x=1' } }), e => e.code === 'REQUEST_TIMEOUT' && e.uncertainOutcome === true); }
  finally { await client.stop(); }
  assert.equal((await fs.readFile(path.join(f.dataDir, 'writes'), 'utf8')).trim().split('\n').length, 1);
});
test('I1 retains only the exact safe audit warning from real HTTP responses', async t => {
  const { EngineClient } = require('..'); const f = await fixture(t, 'audit-warning'); const client = await EngineClient.start(options(f));
  try {
    const result = await client.request({ method: 'GET', path: '/api/connections' });
    assert.deepEqual(result.headers, { 'content-type': 'application/json', 'x-request-id': '12345678-1234-1234-1234-123456789abc', 'x-gridbase-audit-warning': 'incomplete' });
    const write = await client.request({ method: 'POST', path: '/api/query', body: { sql: 'UPDATE fixture SET x=1' } });
    assert.equal(write.status, 200); assert.equal(write.headers['x-gridbase-audit-warning'], 'incomplete'); assert.equal(JSON.parse(write.body).writes, 1);
    const invalid = await client.request({ method: 'GET', path: '/api/health' });
    assert.equal(invalid.headers['x-gridbase-audit-warning'], undefined); assert(!JSON.stringify(invalid.headers).includes('secret'));
  } finally { await client.stop(); }
});
test('I3 refuses worker-thread ownership before launching or creating engine state', async t => {
  const { Worker } = require('node:worker_threads'); const f = await fixture(t);
  const source = `const {parentPort}=require('node:worker_threads');const {EngineClient}=require(${JSON.stringify(path.resolve(__dirname, '..'))});EngineClient.start({...JSON.parse(process.argv[2]),credentialKey:Buffer.alloc(32,7)}).then(async c=>{await c.stop();parentPort.postMessage('unexpected-start')}).catch(e=>parentPort.postMessage(e.code));`;
  const worker = new Worker(source, { eval: true, argv: [JSON.stringify({ bundleDir: f.bundleDir, dataDir: f.dataDir, tempDir: f.tempDir, clientKind: f.clientKind })] });
  const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }); await worker.terminate();
  assert.equal(result, 'START_FAILED'); await assert.rejects(fs.stat(f.dataDir), { code: 'ENOENT' });
});
