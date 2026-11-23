'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const crypto = require('node:crypto');
const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path'); const { spawn } = require('node:child_process');
const { RpcTransport, HostPrivateFilesSession } = require('../windows-private-files');
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
function distribution() {
  const files = { 'jre/bin/java.exe': 'synthetic Java', 'resources/VERSION': '1.4.0\n', 'resources/public/index.html': 'synthetic public', 'engine/native/win32-x64/gridbase-private-files.exe': 'synthetic helper', 'engine/native/win32-x64/gridbase-launch-owned.exe': 'synthetic launcher', 'lib/app.jar': 'synthetic jar' };
  const manifest = { schema: 1, protocol: 1, version: '1.4.0', platform: 'win32', arch: 'x64', java: 'jre/bin/java.exe', resources: 'resources', classpath: ['lib/app.jar'], files: Object.entries(files).map(([path, text]) => ({ path, sha256: digest(Buffer.from(text)) })) };
  return { files, manifest };
}
function config(d) {
  const texts = { ...d.files, 'engine/manifest.json': d.source ?? JSON.stringify(d.manifest) };
  const entries = [], dirs = new Set(); let index = 9007199254740993n;
  for (const [name, text] of Object.entries(texts)) {
    let dir = ''; for (const part of name.split('/').slice(0, -1)) { dir += (dir ? '/' : '') + part; dirs.add(dir); }
    const b = Buffer.isBuffer(text) ? text : Buffer.from(text);
    entries.push({ kind: 2, path: name, index: String(index++), size: String(b.length), sha256: digest(b) });
  }
  for (const name of dirs) entries.push({ kind: 1, path: name, index: String(index++), size: '0', sha256: '0'.repeat(64) });
  return { files: Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, Buffer.from(text).toString('base64')])), pages: [{ cursor: 0, next: 41, entries: entries.slice(0, 4) }, { cursor: 41, next: 0, entries: entries.slice(4) }] };
}
async function session(t, c) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-windows-b-manifest-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  c.trace = path.join(dir, 'trace'); const file = path.join(dir, 'config.json'); await fs.writeFile(file, JSON.stringify(c));
  const child = spawn(process.execPath, [path.join(__dirname, 'windows-host-rpc-fixture.cjs'), file], { stdio: ['pipe','pipe','pipe'] });
  const rpc = new RpcTransport(child); const nativeSession = new HostPrivateFilesSession(rpc); t.after(() => rpc.abort());
  return { nativeSession, trace: async () => (await fs.readFile(c.trace, 'utf8')).trim().split('\n').map(JSON.parse) };
}
test('native-session manifest verifier consumes split binary inventory with exact BigInt identities', async t => {
  const { nativeSession, trace } = await session(t, config(distribution()));
  const load = require('../windows-manifest').loadWindowsManifest;
  const result = await load(nativeSession, 'C:\\Installed 空');
  assert.deepEqual(result, { version: '1.4.0', java: 'C:\\Installed 空\\jre\\bin\\java.exe', resources: 'C:\\Installed 空\\resources', classpath: ['C:\\Installed 空\\lib\\app.jar'] });
  assert.equal(nativeSession.bundles.size, 0); assert.equal(nativeSession.rpc.dead, false);
  assert.deepEqual((await trace()).map(v => v.op), [8,9,10,10,9,9,12]);
});
const cases = {
  'listed file limit': d => { d.manifest.files=Array(20001).fill(d.manifest.files[0]); },
  'schema/unknown field': d => { d.manifest.extra = true; },
  'duplicate JSON key': d => { d.source = JSON.stringify(d.manifest).replace('"schema":1', '"schema":1,"schema":1'); },
  'invalid UTF8': d => { d.source = Buffer.from([255]); },
  'BOM JSON': d => { d.source = '\ufeff' + JSON.stringify(d.manifest); },
  'invalid semver': d => { d.manifest.version = '01.4.0'; },
  'wrong platform': d => { d.manifest.platform = 'linux'; },
  'wrong arch': d => { d.manifest.arch = 'arm64'; },
  'non-jar regular classpath': d => { d.manifest.classpath=['jre/bin/java.exe']; },
  'path escape': d => { d.manifest.java = '../java'; },
  'semicolon classpath': d => { d.manifest.classpath = ['lib/a;b.jar']; },
  'classpath duplicate case': d => { d.manifest.classpath.push('LIB/APP.JAR'); },
  'classpath count': d => { d.manifest.classpath = Array(1025).fill('lib/app.jar'); },
  'missing helper': d => { delete d.files['engine/native/win32-x64/gridbase-launch-owned.exe']; d.manifest.files.pop(); d.manifest.files = d.manifest.files.filter(f => !f.path.endsWith('gridbase-launch-owned.exe')); },
  'native fixture executable in distribution': d => { d.files['engine/native/win32-x64/native-fixture.exe'] = 'fixture'; d.manifest.files.push({path:'engine/native/win32-x64/native-fixture.exe',sha256:digest(Buffer.from('fixture'))}); },
  'duplicate listed path': d => { d.manifest.files.push(d.manifest.files[0]); },
  'prefix case alias': d => { d.files['Resources/other'] = 'x'; d.manifest.files.push({ path: 'Resources/other', sha256: digest(Buffer.from('x')) }); },
  'unlisted file': d => { d.files['extra'] = 'x'; },
  'missing file': d => { delete d.files['lib/app.jar']; },
  'tampered file': d => { d.files['lib/app.jar'] = 'tampered'; },
  'wrong VERSION': d => { d.files['resources/VERSION'] = '1.5.0'; },
  'manifest >1MiB': d => { d.source = ' '.repeat(1048577); },
};
for (const [name, mutate] of Object.entries(cases)) test('Windows inventory refuses ' + name + ' and closes only its bundle', async t => {
  const d = distribution(); mutate(d); const { nativeSession, trace } = await session(t, config(d));
  await assert.rejects(require('../windows-manifest').loadWindowsManifest(nativeSession, 'C:\\Installed'), { code: 'INVALID_MANIFEST' });
  assert.equal(nativeSession.bundles.size, 0); assert.equal(nativeSession.roots.size, 0);
  assert.equal((await trace()).filter(v => v.op === 12).length, 1);
});
const inventoryCases = {
  'repeated cursor': c => { c.pages[1].next = 41; },
  'empty continuation': c => { c.pages[0].entries = []; },
  'empty terminal continuation': c => {c.pages[1].next=77;c.pages.push({cursor:77,next:0,entries:[]});},
  'duplicate inventory path': c => { c.pages[1].entries.push(c.pages[0].entries[0]); },
  'unknown identity': c => { c.pages[0].entries[0].index = '0'; },
  'duplicate native identity': c => { c.pages[0].entries[1].index = c.pages[0].entries[0].index; },
  'manifest digest disagreement': c => { c.pages[1].entries.find(e => e.path === 'engine/manifest.json').sha256 = '1'.repeat(64); },
  'manifest size disagreement': c => { c.pages[1].entries.find(e => e.path === 'engine/manifest.json').size = '9007199254740993'; },
  'inventory prefix case alias': c => { c.pages[1].entries.push({kind:1,path:'RESOURCES/alias',index:'12345',size:'0',sha256:'0'.repeat(64)}); },
  'missing public directory': c => { for (const p of c.pages) p.entries = p.entries.filter(e => e.path !== 'resources/public'); },
  'wrong classpath kind': c => { const e = c.pages[1].entries.find(e => e.path === 'lib'); e.kind = 2; e.sha256 = '1'.repeat(64); },
  'missing parent directory': c => { for (const p of c.pages) p.entries = p.entries.filter(e => e.path !== 'jre'); },
  'repeat manifest changed': c => { c.repeat = Buffer.from('{}').toString('base64'); },
  'over-limit page': c => { c.pages[0].entries = Array(257).fill(c.pages[0].entries[0]); },
  'invalid directory kind': c => { c.pages[0].entries[0].kind = 3; },
  'invalid directory digest': c => { const e=c.pages[1].entries.find(e=>e.kind===1);e.sha256='1'.repeat(64); },
};
for (const [name, mutate] of Object.entries(inventoryCases)) test('Windows inventory refuses ' + name, async t => {
  const c = config(distribution()); mutate(c); const { nativeSession } = await session(t, c);
  await assert.rejects(require('../windows-manifest').loadWindowsManifest(nativeSession, 'C:\\Installed'), { code: 'INVALID_MANIFEST' });
  if(nativeSession.rpc.dead) await nativeSession.rpc.closed;
  else assert.equal(nativeSession.bundles.size, 0);
});
test('Windows verifier rejects root delimiter before native side effects and public gate remains fixed', async () => {
  const { assertSupportedPlatform } = require('../private-paths');
  assert.throws(() => assertSupportedPlatform('win32'), { code: 'WINDOWS_PRIVATE_STORAGE_UNSUPPORTED' });
  await assert.rejects(require('../windows-manifest').loadWindowsManifest(null, 'C:\\Installed;bad'), { code: 'INVALID_MANIFEST' });
});
test('native inventory cumulative entries are bounded across many valid pages',async t=>{
  const c=config(distribution()),entries=c.pages.flatMap(p=>p.entries);
  for(let i=0;i<40001;i++)entries.push({kind:1,path:'directory'+i,index:String(100000+i),size:'0',sha256:'0'.repeat(64)});
  c.pages=[];for(let offset=0;offset<entries.length;offset+=256)c.pages.push({cursor:offset===0?0:offset,next:offset+256<entries.length?offset+256:0,entries:entries.slice(offset,offset+256)});
  const {nativeSession,trace}=await session(t,c);await assert.rejects(require('../windows-manifest').loadWindowsManifest(nativeSession,'C:\\Installed'),{code:'INVALID_MANIFEST'});assert.equal(nativeSession.bundles.size,0);assert((await trace()).filter(x=>x.op===10).length<=157);
});
module.exports = { distribution, config, session };
