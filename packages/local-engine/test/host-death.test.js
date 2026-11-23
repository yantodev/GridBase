'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os'); const { spawn } = require('node:child_process'); const { once } = require('node:events');
const { realBundle, addJdbcFixture, root } = require('./java-fixture.cjs'); const { waitFile } = require('./fixture.cjs');
async function identity(pid) {
  try { const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' '); return { state: fields[0], start: fields[19] }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function isOwnedLive(owned) { const current = await identity(owned.pid); return current !== null && current.start === owned.start && current.state !== 'Z'; }
async function awaitDead(owned, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (!await isOwnedLive(owned)) return true; await new Promise(r => setTimeout(r, 20)); } return !await isOwnedLive(owned); }
test('I3 abrupt owning Node host SIGKILL while real JDBC is blocked kills exact JVM and permits reopen', { timeout: 55000 }, async t => {
  const { EngineClient } = require('..'); const f = await realBundle(t); await addJdbcFixture(f); const { root: unused, credentialKey: secret, ...options } = f;
  const marker = path.join(f.root, 'host-ready');
  const source = `const fs=require('node:fs');const {EngineClient}=require(${JSON.stringify(path.join(root, 'packages/local-engine'))});(async()=>{const c=await EngineClient.start({...JSON.parse(process.argv[1]),credentialKey:Buffer.alloc(32,19)});const profile={type:'postgresql',connectionId:'fixture',name:'fixture',jdbcUrl:'jdbc:postgresql://localhost/fixture',username:'synthetic-user',password:'synthetic-password'};if((await c.request({method:'POST',path:'/api/connections/connect',body:profile})).status!==200)throw Error();fs.writeFileSync(process.argv[2],'ready');c.request({method:'POST',path:'/api/query',body:{sql:'UPDATE fixture SET x=3',connectionId:'fixture'}}).catch(()=>{});setInterval(()=>{},1000)})().catch(()=>process.exit(2));`;
  const host = spawn(process.execPath, ['-e', source, JSON.stringify(options), marker], { env: { LANG: 'C.UTF-8', TMPDIR: os.tmpdir() }, stdio: ['ignore','ignore','ignore'] }); const hostClosed = once(host, 'close'); let owned;
  try {
    await waitFile(marker, 30000); await waitFile(path.join(f.dataDir, 'jdbc-writes'));
    const children = (await fs.readFile(`/proc/${host.pid}/task/${host.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number); assert.equal(children.length, 1);
    const pid = children[0], initial = await identity(pid); assert(initial && initial.state !== 'Z');
    assert.equal(await fs.readlink(`/proc/${pid}/exe`), path.join(f.bundleDir, 'jre/bin/java')); owned = { pid, start: initial.start };
    assert.equal((await fs.readFile(path.join(f.dataDir, 'jdbc-writes'), 'utf8')).trim().split('\n').length, 1);
    host.kill('SIGKILL'); const [code, signal] = await hostClosed; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    const dead = await awaitDead(owned, 6500);
    if (!dead) {
      await assert.rejects(EngineClient.start({ ...options, credentialKey: secret, tempDir: path.join(f.root, 'contender-temp') }));
      t.diagnostic('RED observed exact owned JVM live beyond 6.5s and actual contender refused while one JDBC write remains blocked');
    }
    assert.equal(dead, true, 'owned JVM survived abrupt host death with blocked JDBC');
    assert.equal((await fs.readFile(path.join(f.dataDir, 'jdbc-writes'), 'utf8')).trim().split('\n').length, 1);
    await fs.writeFile(path.join(f.dataDir, 'jdbc-release'), 'release');
    const reopened = await EngineClient.start({ ...options, credentialKey: secret }); await reopened.stop();
    t.diagnostic('GREEN actual Node host SIGKILL -> exact JVM dead bounded; one JDBC entry, same workspace reopened, no query retry');
  } finally {
    if (host.exitCode === null && host.signalCode === null) { host.kill('SIGKILL'); await hostClosed; }
    if (owned && await isOwnedLive(owned)) { process.kill(owned.pid, 'SIGKILL'); assert(await awaitDead(owned, 5000), 'exact owned PID cleanup failed'); t.diagnostic('RED cleanup killed only captured owned PID with matching process start identity'); }
  }
});
