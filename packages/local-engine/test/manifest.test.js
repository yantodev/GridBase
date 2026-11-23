'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-manifest-空 ')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle'); await fs.mkdir(path.join(bundle, 'engine'), { recursive: true });
  await fs.mkdir(path.join(bundle, 'resources/public'), { recursive: true }); await fs.mkdir(path.join(bundle, 'classes'));
  await fs.mkdir(path.join(bundle, 'engine/native'));
  const values = { 'java': 'executable', 'engine/native/gridbase-launcher': 'launcher', 'classes/Main.class': 'class', 'resources/VERSION': '1.4.0\n', 'resources/public/index.html': 'fixture' };
  for (const [name, value] of Object.entries(values)) await fs.writeFile(path.join(bundle, name), value);
  const manifest = { schema: 1, protocol: 1, version: '1.4.0', platform: process.platform, arch: process.arch, java: 'java', resources: 'resources', classpath: ['classes'], files: Object.entries(values).map(([name, value]) => ({ path: name, sha256: crypto.createHash('sha256').update(value).digest('hex') })) };
  await fs.chmod(path.join(bundle, 'java'), 0o700);
  await fs.chmod(path.join(bundle, 'engine/native/gridbase-launcher'), 0o700);
  const save = () => fs.writeFile(path.join(bundle, 'engine/manifest.json'), JSON.stringify(manifest)); await save();
  return { root, bundle, manifest, save };
}
test('manifest validates exact inventory, target, checksums and resource version', async t => {
  const { loadManifest } = require('../manifest'); const f = await fixture(t);
  const m = await loadManifest(f.bundle); assert.equal(m.java, path.join(f.bundle, 'java')); assert.equal(m.classpath.length, 1);
  for (const mutate of [m => m.extra = true, m => m.files.push(m.files[0]), m => m.classpath = [], m => m.java = '/bin/java', m => m.platform = 'win32', m => m.classpath = ['*'], m => m.files[0].sha256 = '0'.repeat(64)]) {
    const before = JSON.stringify(f.manifest); mutate(f.manifest); await f.save();
    await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' }); Object.assign(f.manifest, JSON.parse(before)); delete f.manifest.extra;
  }
  await f.save(); await fs.writeFile(path.join(f.bundle, 'classes/unlisted.class'), 'bad'); await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' });
});
test('manifest refuses symlinks, hardlinks, duplicate JSON and case aliases', async t => {
  const { loadManifest } = require('../manifest'); const f = await fixture(t); const file = path.join(f.bundle, 'java');
  await fs.rename(file, path.join(f.root, 'outside')); await fs.symlink(path.join(f.root, 'outside'), file);
  await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' }); await fs.unlink(file); await fs.link(path.join(f.root, 'outside'), file);
  await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' }); await fs.unlink(file); await fs.copyFile(path.join(f.root, 'outside'), file); await fs.chmod(file, 0o700);
  await fs.writeFile(path.join(f.bundle, 'engine/manifest.json'), JSON.stringify(f.manifest).replace('"schema":1', '"schema":1,"schema":1'));
  await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' }); await f.save();
  f.manifest.files.push({ ...f.manifest.files[0], path: 'JAVA' }); await f.save(); await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' });
});
test('private path refuses shared modes, symlinks, hardlinks and Windows without helper', async t => {
  const { privateDirectory, readPrivateFile, assertSupportedPlatform } = require('../private-paths'); const f = await fixture(t);
  const dir = path.join(f.root, 'private'); await privateDirectory(dir); assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  await fs.writeFile(path.join(dir, 'key'), 'fixture', { mode: 0o600 }); assert.equal((await readPrivateFile(path.join(dir, 'key'), 100)).toString(), 'fixture');
  await fs.link(path.join(dir, 'key'), path.join(dir, 'alias')); await assert.rejects(readPrivateFile(path.join(dir, 'key'), 100), { code: 'PRIVATE_PATH' });
  await fs.chmod(dir, 0o755); await assert.rejects(privateDirectory(dir), { code: 'PRIVATE_PATH' });
  assert.throws(() => assertSupportedPlatform('win32'), { code: 'WINDOWS_PRIVATE_STORAGE_UNSUPPORTED' });
});
module.exports = { fixture };
test('private storage rejects writable foreign ancestors before creating any child', async t => {
  const { privateDirectory } = require('../private-paths'); const f = await fixture(t);
  const shared = path.join(f.root, 'shared'); await fs.mkdir(shared, { mode: 0o777 }); await fs.chmod(shared, 0o777);
  await assert.rejects(privateDirectory(path.join(shared, 'new-secret-dir')), { code: 'PRIVATE_PATH' });
  assert.deepEqual(await fs.readdir(shared), []); assert.equal((await fs.stat(shared)).mode & 0o777, 0o777);
});
test('manifest handles strict UTF8, resource version, target arch, path escapes and executable coverage', async t => {
  const { loadManifest } = require('../manifest');
  for (const mutate of [m => m.arch = 'arm64', m => m.resources = '../resources', m => m.classpath = ['/classes'], m => m.files[0].path = 'a/../java', m => m.files[0].unknown = true, m => m.files[0].sha256 = m.files[0].sha256.toUpperCase(), m => m.java = 'engine/manifest.json']) {
    const f = await fixture(t); mutate(f.manifest); await f.save(); await fs.chmod(path.join(f.bundle, 'engine/manifest.json'), 0o700);
    await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' });
  }
  const version = await fixture(t); version.manifest.version = '1.4.1'; await version.save(); await assert.rejects(loadManifest(version.bundle), { code: 'INVALID_MANIFEST' });
  const utf8 = await fixture(t); await fs.writeFile(path.join(utf8.bundle, 'engine/manifest.json'), Buffer.from([0xff])); await assert.rejects(loadManifest(utf8.bundle), { code: 'INVALID_MANIFEST' });
  await fs.writeFile(path.join(utf8.bundle, 'engine/manifest.json'), ' '.repeat(1024 * 1024 + 1)); await assert.rejects(loadManifest(utf8.bundle), { code: 'INVALID_MANIFEST' });
  const colon = await fixture(t); const renamed = colon.bundle + ':classpath'; await fs.rename(colon.bundle, renamed); await assert.rejects(loadManifest(renamed), { code: 'INVALID_MANIFEST' });
});
test('manifest semver is strict even when its hashed resource version agrees', async t => {
  const { loadManifest } = require('../manifest');
  for (const version of ['1.4.0-01','1.4.0-alpha..one','1.4.0+build..two']) {
    const f = await fixture(t); f.manifest.version = version;
    const bytes = Buffer.from(version + '\n'); await fs.writeFile(path.join(f.bundle, 'resources/VERSION'), bytes);
    f.manifest.files.find(e => e.path === 'resources/VERSION').sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); await f.save();
    await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' });
  }
});
test('I3 Linux manifest requires fixed inventoried executable ordinary launcher', async t => {
  const { loadManifest } = require('../manifest'); const f = await fixture(t); const rel = 'engine/native/gridbase-launcher';
  const file = path.join(f.bundle, rel);
  assert.equal((await loadManifest(f.bundle)).launcher, file);
  await fs.chmod(file, 0o600); await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' });
  await fs.chmod(file, 0o4700); await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' });
  await fs.chmod(file, 0o700); await fs.writeFile(file, 'tampered'); await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' });
  await fs.writeFile(file, 'launcher');
  const outside = path.join(f.root, 'outside-launcher'); await fs.rename(file, outside); await fs.symlink(outside, file); await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' });
  await fs.unlink(file); await fs.link(outside, file); await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' }); await fs.unlink(file);
  await fs.rename(outside, file);
  f.manifest.files = f.manifest.files.filter(e => e.path !== rel); await fs.unlink(file); await f.save(); await assert.rejects(loadManifest(f.bundle), { code: 'INVALID_MANIFEST' });
});
