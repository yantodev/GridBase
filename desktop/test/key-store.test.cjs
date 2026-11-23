'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-key-')); await fs.chmod(dir, 0o700); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function storage(backend = 'gnome_libsecret', available = true) {
  const key = Buffer.alloc(32, 42);
  return { getSelectedStorageBackend: () => backend, isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async text => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([Buffer.from('v11'), iv, cipher.getAuthTag(), encrypted]); },
    decryptStringAsync: async bytes => { bytes = bytes.subarray(3); const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false }; }
  };
}
function provider(safeStorage = storage(), platform = 'linux', ready = true) { return require('../key-store.cjs').createKeyProvider({ safeStorage, platform, app: { isReady: () => ready } }); }
test('async safeStorage encrypts 32 bytes and reopens the identical established key', async t => {
  const dir = await directory(t), load = provider(); const key = await load(dir, { allowPlaintextFallback: false }); assert.equal(key.length, 32);
  const bytes = await fs.readFile(path.join(dir, 'credential-key.v1')); assert(!bytes.includes(key)); assert(!bytes.includes(Buffer.from(key.toString('base64url'))));
  assert.deepEqual(await load(dir, { allowPlaintextFallback: false }), key); assert.deepEqual(await fs.readFile(path.join(dir, 'credential-key.v1')), bytes);
  assert.equal((await fs.stat(path.join(dir, 'credential-key.v1'))).mode & 0o777, 0o600);
});
test('Linux basic_text/unavailable needs explicit persisted consent and never changes protection', async t => {
  for (const s of [storage('basic_text'), storage('gnome_libsecret', false)]) {
    const dir = await directory(t); const load = provider(s);
    await assert.rejects(load(dir, { allowPlaintextFallback: false }), { code: 'FALLBACK_CONSENT_REQUIRED' }); assert.deepEqual(await fs.readdir(dir), []);
    const key = await load(dir, { allowPlaintextFallback: true });
    const consent = JSON.parse(await fs.readFile(path.join(dir, 'key-consent.v1.json'), 'utf8')); assert.deepEqual(consent, { allowPlaintextFallback: true });
    const before = await fs.readFile(path.join(dir, 'credential-key.v1'));
    assert.deepEqual(await provider()(dir, { allowPlaintextFallback: false }), key); assert.deepEqual(await fs.readFile(path.join(dir, 'credential-key.v1')), before);
    await fs.unlink(path.join(dir, 'key-consent.v1.json')); await assert.rejects(load(dir, { allowPlaintextFallback: true }), { code: 'KEY_UNAVAILABLE' });
  }
});
test('encrypted key wrong backend/corruption/encryption failures never regenerate or downgrade', async t => {
  const dir = await directory(t), load = provider(); await load(dir, { allowPlaintextFallback: false }); const file = path.join(dir, 'credential-key.v1'), original = await fs.readFile(file);
  await assert.rejects(provider(storage('basic_text'))(dir, { allowPlaintextFallback: true }), { code: 'KEY_BACKEND_UNAVAILABLE' }); assert.deepEqual(await fs.readFile(file), original);
  await assert.rejects(provider(storage('kwallet6'))(dir, { allowPlaintextFallback: true }), { code: 'KEY_BACKEND_UNAVAILABLE' });
  await fs.writeFile(file, 'corrupt'); await assert.rejects(load(dir, { allowPlaintextFallback: false }), { code: 'KEY_UNAVAILABLE' }); assert.equal(await fs.readFile(file, 'utf8'), 'corrupt');
  const failing = storage(); failing.encryptStringAsync = async () => { throw Error('SECRET-password-private-path'); }; const fresh = await directory(t);
  await assert.rejects(provider(failing)(fresh, { allowPlaintextFallback: true }), e => e.code === 'KEY_UNAVAILABLE' && !String(e).includes('SECRET'));
});
test('missing established key, partial initialization and hostile paths fail closed', async t => {
  const dir = await directory(t); await fs.writeFile(path.join(dir, 'local-workspace.json'), '{}', { mode: 0o600 });
  await assert.rejects(provider()(dir, { allowPlaintextFallback: false }), { code: 'KEY_MISSING' }); assert.deepEqual(await fs.readdir(dir), ['local-workspace.json']);
  const partial = await directory(t); await fs.writeFile(path.join(partial, 'credential-key.v1'), '', { mode: 0o600 }); await assert.rejects(provider()(partial, { allowPlaintextFallback: false }), { code: 'KEY_UNAVAILABLE' });
  const target = await directory(t), link = await directory(t); await fs.symlink(target, path.join(link, 'linked')); await assert.rejects(provider()(path.join(link, 'linked'), { allowPlaintextFallback: false }), { code: 'PRIVATE_PATH' });
  const hard = await directory(t); await provider()(hard, { allowPlaintextFallback: false }); await fs.link(path.join(hard, 'credential-key.v1'), path.join(hard, 'alias')); await assert.rejects(provider()(hard, { allowPlaintextFallback: false }), { code: 'KEY_UNAVAILABLE' });
});
test('exclusive initialization races preserve winner and Windows remains unsupported', async t => {
  const dir = await directory(t); const results = await Promise.allSettled(Array.from({ length: 8 }, () => provider()(dir, { allowPlaintextFallback: false })));
  const winners = results.filter(r => r.status === 'fulfilled'); assert(winners.length >= 1); for (const r of winners) assert.deepEqual(r.value, winners[0].value);
  for (const r of results.filter(r => r.status === 'rejected')) assert.equal(r.reason.code, 'KEY_INITIALIZING');
  assert.deepEqual(await provider()(dir, { allowPlaintextFallback: false }), winners[0].value);
  const windows = await directory(t); await assert.rejects(provider(storage(), 'win32')(windows, { allowPlaintextFallback: true }), { code: 'WINDOWS_PRIVATE_STORAGE_UNSUPPORTED' }); assert.deepEqual(await fs.readdir(windows), []);
  await assert.rejects(provider(storage(), 'linux', false)(await directory(t), { allowPlaintextFallback: false }), { code: 'APP_NOT_READY' });
});
module.exports = { storage };
test('Electron 45 async availability alone cannot authorize Chromium v10 plaintext fallback', async t => {
  const dir = await directory(t), fallback = storage();
  fallback.encryptStringAsync = async text => Buffer.concat([Buffer.from('v10'), Buffer.from(text).map(x => x ^ 0x55)]);
  fallback.decryptStringAsync = async bytes => ({ result: Buffer.from(bytes.subarray(3)).map(x => x ^ 0x55).toString(), shouldReEncrypt: false });
  await assert.rejects(provider(fallback)(dir, { allowPlaintextFallback: false }), { code: 'KEY_BACKEND_UNAVAILABLE' });
  assert(!(await fs.readdir(dir)).includes('credential-key.v1'));
});
test('independent host processes exclusively initialize one reopenable key', async t => {
  const { spawn } = require('node:child_process'); const dir = await directory(t);
  const keyStore = path.resolve(__dirname, '../key-store.cjs');
  const source = `const {createKeyProvider}=require(${JSON.stringify(keyStore)}); const crypto=require('node:crypto'); const safeStorage={getSelectedStorageBackend:()=> 'gnome_libsecret',isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async text=>Buffer.concat([Buffer.from('v11'),Buffer.from(text).map(x=>x^0x55)]),decryptStringAsync:async bytes=>({result:Buffer.from(bytes.subarray(3)).map(x=>x^0x55).toString(),shouldReEncrypt:false})}; createKeyProvider({safeStorage,app:{isReady:()=>true}})(process.argv[1],{allowPlaintextFallback:false}).then(k=>process.stdout.write(crypto.createHash('sha256').update(k).digest('hex'))).catch(e=>{process.stdout.write(e.code);process.exitCode=2});`;
  const runs = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, dir], { env: { LANG: 'C.UTF-8' }, stdio: ['ignore','pipe','pipe'] }); let output = '', errors = '';
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => errors += b); child.once('error', reject); child.once('close', code => resolve({ code, output, errors }));
  })));
  const successes = runs.filter(r => r.code === 0); assert(successes.length >= 1);
  for (const r of runs) { assert.equal(r.errors, ''); if (r.code === 0) assert.equal(r.output, successes[0].output); else { assert.equal(r.code, 2); assert.equal(r.output, 'KEY_INITIALIZING'); } }
  const s = storage(); s.decryptStringAsync = async bytes => ({ result: Buffer.from(bytes.subarray(3)).map(x => x ^ 0x55).toString(), shouldReEncrypt: true });
  const before = await fs.readFile(path.join(dir, 'credential-key.v1')); const key = await provider(s)(dir, { allowPlaintextFallback: false });
  assert.equal(crypto.createHash('sha256').update(key).digest('hex'), successes[0].output); assert.deepEqual(await fs.readFile(path.join(dir, 'credential-key.v1')), before);
});
test('late contender cannot leave an initialization claim over an established key', async t => {
  const dir = await directory(t), slow = storage(); let enter, release;
  const entered = new Promise(r => enter = r), barrier = new Promise(r => release = r);
  slow.isAsyncEncryptionAvailable = async () => { enter(); await barrier; return true; };
  const contender = provider(slow)(dir, { allowPlaintextFallback: false }); const observed = contender.then(key => ({ key }), error => ({ error }));
  await entered; const winner = await provider()(dir, { allowPlaintextFallback: false }); const before = await fs.readFile(path.join(dir, 'credential-key.v1'));
  release(); const result = await observed;
  assert.ifError(result.error); assert.deepEqual(result.key, winner); assert.deepEqual(await fs.readFile(path.join(dir, 'credential-key.v1')), before);
  assert.deepEqual(await provider()(dir, { allowPlaintextFallback: false }), winner);
});
test('corrupt raw fallback key refuses reopen rather than returning a changed key', async t => {
  const dir = await directory(t), load = provider(storage('basic_text'));
  await load(dir, { allowPlaintextFallback: true });
  const file = path.join(dir, 'credential-key.v1'), bytes = await fs.readFile(file); bytes[bytes.length - 1] ^= 1; await fs.writeFile(file, bytes);
  await assert.rejects(load(dir, { allowPlaintextFallback: true }), { code: 'KEY_UNAVAILABLE' }); assert.deepEqual(await fs.readFile(file), bytes);
});
