'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path'); const { spawn } = require('node:child_process');
const { waitFile } = require('./fixture.cjs');
const { realBundle, addJdbcFixture, root } = require('./java-fixture.cjs');
test('real packaged Java 17 authenticates, persists encrypted fixture profile, reopens and shuts down', { timeout: 60000 }, async t => {
  const { EngineClient } = require('..'); const f = await realBundle(t); const { root: unused, ...options } = f;
  const client = await EngineClient.start(options); t.after(() => client.stop());
  t.diagnostic('actual JVM launch 1 ready; verified inventory, private extraction, authenticated owner');
  assert.equal((await client.request({ method: 'GET', path: '/healthz' })).status, 200);
  const profile = { type: 'postgresql', connectionId: 'fixture', name: 'fixture', host: 'localhost', port: '5432', database: 'fixture', username: 'synthetic-user', password: 'synthetic-password', mcpReadOnly: true };
  assert.equal((await client.request({ method: 'POST', path: '/api/connections', body: profile })).status, 200);
  const details = JSON.parse((await client.request({ method: 'GET', path: '/api/connections/fixture' })).body); assert.equal(details.password, 'synthetic-password');
  const activity = JSON.parse((await client.request({ method: 'GET', path: '/api/activity?scope=mine&limit=10' })).body); assert(activity.events.every(e => e.source === 'desktop'));
  assert.equal((await client.request({ method: 'GET', path: '/api/local/mcp' })).status, 200);
  assert((await fs.readdir(f.tempDir)).some(n => n.startsWith('sqlite-'))); assert(!(await fs.readdir(f.dataDir)).includes('credentials.key'));
  await client.stop();
  const again = await EngineClient.start(options); try { assert.equal(JSON.parse((await again.request({ method: 'GET', path: '/api/connections/fixture' })).body).password, 'synthetic-password'); } finally { await again.stop(); }
  t.diagnostic('actual JVM launches 1 and 2 stopped; same fixture profile decrypts on reopen');
  const wrong = { ...options, credentialKey: Buffer.alloc(32, 20) }; await assert.rejects(EngineClient.start(wrong));
  t.diagnostic('actual JVM launch 3 rejected wrong credential key before readiness and terminated');
});
test('terminating host closes stdin and the real owned Java process exits', { timeout: 60000 }, async t => {
  const f = await realBundle(t); const report = path.join(f.root, 'host-ready');
  const hostCode = `const fs=require('node:fs'); const {EngineClient}=require(${JSON.stringify(path.join(root, 'packages/local-engine'))}); EngineClient.start({...JSON.parse(process.argv[1]),credentialKey:Buffer.alloc(32,19)}).then(c=>{fs.writeFileSync(process.argv[2],'ready');setInterval(()=>{},1000)}).catch(()=>process.exit(2));`;
  const { root: unused, credentialKey: secret, ...options } = f;
  const host = spawn(process.execPath, ['-e', hostCode, JSON.stringify(options), report], { env: { LANG: 'C.UTF-8', TMPDIR: os.tmpdir() }, stdio: ['ignore','ignore','ignore'] });
  t.after(() => { if (host.exitCode === null) host.kill('SIGKILL'); });
  await waitFile(report, 30000);
  // Exact child's PID is observed from this fixture host's /proc children, not
  // a global process-name search and never a live service PID.
  const children = (await fs.readFile(`/proc/${host.pid}/task/${host.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number); assert.equal(children.length, 1);
  const pid = children[0]; host.kill('SIGTERM'); await new Promise(r => host.once('close', r));
  const end = Date.now() + 15000; let live = true;
  while (Date.now() < end) { try { const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); if (stat.split(') ')[1].startsWith('Z')) { live = false; break; } } catch (e) { if (e.code === 'ENOENT') { live = false; break; } throw e; } await new Promise(r => setTimeout(r, 20)); }
  assert.equal(live, false, 'owned JVM remained live after host termination');
  t.diagnostic('actual JVM launch 4 exited after its actual Node host was terminated; no process-name/global kills');
});
test('real JDBC abort is uncertain once, holds workspace lock, then stop enforces exact five-second kill', { timeout: 45000 }, async t => {
  const { EngineClient } = require('..'); const f = await realBundle(t); await addJdbcFixture(f); const { root: ignored, ...options } = f;
  const client = await EngineClient.start(options); t.after(() => client.stop());
  const profile = { type: 'postgresql', connectionId: 'fixture', name: 'fixture', jdbcUrl: 'jdbc:postgresql://localhost/fixture', username: 'synthetic-user', password: 'synthetic-password' };
  assert.equal((await client.request({ method: 'POST', path: '/api/connections/connect', body: profile })).status, 200);
  const controller = new AbortController(); const query = client.request({ method: 'POST', path: '/api/query', body: { sql: 'UPDATE fixture SET x=2', connectionId: 'fixture' }, signal: controller.signal });
  const checked = assert.rejects(query, e => e.code === 'REQUEST_ABORTED' && e.uncertainOutcome === true);
  await waitFile(path.join(f.dataDir, 'jdbc-writes')); controller.abort(); await checked;
  // A second actual engine is not allowed to own stores while JDBC ignores
  // cancellation. This is not a business-request retry.
  await assert.rejects(EngineClient.start({ ...options, tempDir: path.join(f.root, 'contender-temp') }));
  const start = Date.now(); await client.stop(); assert(Date.now() - start >= 4900);
  assert.equal((await fs.readFile(path.join(f.dataDir, 'jdbc-writes'), 'utf8')).trim().split('\n').length, 1);
  await fs.writeFile(path.join(f.dataDir, 'jdbc-release'), 'release');
  const reopened = await EngineClient.start(options); await reopened.stop();
  t.diagnostic('actual JVM launches 5/6/7: one noninterruptible JDBC submission, locked contender, exact owned kill, store reopen');
});
test('I2 real Java preserves details/deletion for all three action-looking connection IDs', { timeout: 45000 }, async t => {
  const { EngineClient } = require('..'); const f = await realBundle(t); const { root: ignored, ...options } = f;
  const client = await EngineClient.start(options);
  try {
    for (const id of ['test','connect','disconnect']) {
      const profile = { connectionId: id, type: 'postgresql', name: id, jdbcUrl: 'jdbc:postgresql://localhost/fixture', username: 'synthetic-user', password: 'synthetic-password' };
      assert.equal((await client.request({ method: 'POST', path: '/api/connections', body: profile })).status, 200);
      const details = await client.request({ method: 'GET', path: '/api/connections/' + id }); assert.equal(details.status, 200); assert.equal(JSON.parse(details.body).password, profile.password);
      assert.equal((await client.request({ method: 'DELETE', path: '/api/connections/' + id })).status, 200);
      assert.equal((await client.request({ method: 'GET', path: '/api/connections/' + id })).status, 404);
    }
  } finally { await client.stop(); }
});
