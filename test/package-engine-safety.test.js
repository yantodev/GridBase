'use strict';
// Malformed fixtures must only be executed in an OS-enforced disposable sandbox.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { smoke, readonly } = require('../scripts/package-engine/smoke');
const pack = require('../scripts/package-engine');
const extractor = path.resolve(__dirname, '../scripts/package-engine/extract.py');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task7a-fix1-'));
  // Preserve the sandbox-owned evidence; never repair a sentinel after failure.
  t.diagnostic('disposable fixture: ' + root);
  return root;
}
async function modes(...files) {
  return Promise.all(files.map(async file => (await fs.lstat(file)).mode & 0o7777));
}
async function expectUntouched(t, label, sourceKind) {
  const root = await fixture(t);
  const sentinel = path.join(root, 'outside-work-sentinel');
  const sentinelDir = path.join(root, 'outside-work-directory');
  const nested = path.join(sentinelDir, 'sentinel');
  await fs.writeFile(sentinel, 'synthetic sentinel', { mode: 0o640 });
  await fs.mkdir(sentinelDir, { mode: 0o750 });
  await fs.writeFile(nested, 'synthetic nested sentinel', { mode: 0o640 });
  const before = await modes(sentinel, sentinelDir, nested);
  const source = path.join(root, 'source');
  if (sourceKind === 'root-link') await fs.symlink(sentinelDir, source);
  else {
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'ordinary'), 'synthetic bundle');
    if (sourceKind === 'file-link') await fs.symlink(sentinel, path.join(source, 'link'));
    if (sourceKind === 'dir-link') await fs.symlink(sentinelDir, path.join(source, 'link'));
    if (sourceKind === 'hardlink') await fs.link(sentinel, path.join(source, 'alias'));
    if (sourceKind === 'fifo') {
      const made = spawnSync('/usr/bin/mkfifo', [path.join(source, 'fifo')]);
      assert.equal(made.status, 0);
    }
  }
  const work = path.join(root, 'work');
  let failure;
  try { await smoke(source, work); } catch (error) { failure = error; }
  const after = await modes(sentinel, sentinelDir, nested);
  t.diagnostic(JSON.stringify({ label, before, after, rejected: Boolean(failure) }));
  assert.deepEqual(after, before, 'sentinel modes changed before rejection');
  assert.match(failure?.message || '', /unsafe smoke (?:path|tree)/, 'specific type/link policy must reject');
  await assert.rejects(fs.access(work), { code: 'ENOENT' }, 'source must be rejected before work creation/copy');
}
for (const kind of ['file-link', 'dir-link', 'root-link', 'hardlink', 'fifo']) {
  test('I1 source rejects ' + kind + ' before copy/chmod; sentinel modes unchanged', t => expectUntouched(t, kind, kind));
}

test('I1 work ancestor link is refused before creating work or mutating sentinels', async t => {
  const root = await fixture(t), source = path.join(root, 'source'), outside = path.join(root, 'outside-work');
  await fs.mkdir(source); await fs.mkdir(outside, { mode: 0o750 });
  const alias = path.join(root, 'ancestor-link'); await fs.symlink(outside, alias);
  const before = await modes(outside);
  await assert.rejects(smoke(source, path.join(alias, 'work')), /unsafe smoke path/);
  assert.deepEqual(await modes(outside), before);
  assert.deepEqual(await fs.readdir(outside), []);
});

for (const kind of ['file-link', 'dir-link', 'root-link', 'hardlink', 'fifo']) {
  test('I1 copied tree rejects ' + kind + ' before any chmod; sentinel and ordinary modes unchanged', async t => {
    const root = await fixture(t), copy = path.join(root, 'copy');
    const sentinel = path.join(root, 'outside-copy-sentinel'), sentinelDir = path.join(root, 'outside-copy-directory');
    await fs.writeFile(sentinel, 'synthetic'); await fs.mkdir(sentinelDir);
    await fs.writeFile(path.join(sentinelDir, 'nested'), 'synthetic');
    if (kind === 'root-link') await fs.symlink(sentinelDir, copy);
    else {
      await fs.mkdir(copy); await fs.writeFile(path.join(copy, 'a-ordinary'), 'synthetic');
      if (kind === 'file-link') await fs.symlink(sentinel, path.join(copy, 'z-link'));
      if (kind === 'dir-link') await fs.symlink(sentinelDir, path.join(copy, 'z-link'));
      if (kind === 'hardlink') await fs.link(sentinel, path.join(copy, 'z-hardlink'));
      if (kind === 'fifo') assert.equal(spawnSync('/usr/bin/mkfifo', [path.join(copy, 'z-fifo')]).status, 0);
    }
    const targets = [sentinel, sentinelDir, path.join(sentinelDir, 'nested')];
    if (kind !== 'root-link') targets.push(copy, path.join(copy, 'a-ordinary'));
    const before = await modes(...targets);
    let failure; try { await readonly(copy); } catch (error) { failure = error; }
    const after = await modes(...targets);
    t.diagnostic(JSON.stringify({ kind, before, after, policyRejected: Boolean(failure) }));
    assert.deepEqual(after, before, 'full copied-tree validation must precede every chmod');
    assert.match(failure?.message || '', /unsafe smoke (?:path|tree)/);
  });
}

function rawZip(name, directory = false) {
  // Explicit local AND central names; ZipInfo(name) would silently erase NUL.
  const bytes = Buffer.from(name, 'utf8'), data = directory ? Buffer.alloc(0) : Buffer.from('fixture-notice');
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(bytes.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(bytes.length, 28);
  central.writeUInt32LE(((directory ? 0o40700 : 0o100600) << 16) >>> 0, 38);
  const centralOffset = local.length + bytes.length + data.length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + bytes.length, 12); end.writeUInt32LE(centralOffset, 16);
  const result = Buffer.concat([local, bytes, data, central, bytes, end]);
  assert.deepEqual(result.subarray(30, 30 + bytes.length), bytes);
  assert.deepEqual(result.subarray(centralOffset + 46, centralOffset + 46 + bytes.length), bytes);
  return result;
}
async function nulFixture(t, name, directory = false) {
  const root = await fixture(t), file = path.join(root, 'raw.zip');
  const bytes = rawZip(name, directory); await fs.writeFile(file, bytes);
  const script = "import json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);e=z.infolist()[0];print(json.dumps({'original':e.orig_filename,'sanitized':e.filename}));assert chr(0) in e.orig_filename and e.orig_filename!=e.filename";
  const inspected = spawnSync('python3', ['-c', script, file], { encoding: 'utf8' });
  assert.equal(inspected.status, 0, inspected.stderr);
  t.diagnostic('RAW_ZIP_BOTH_HEADERS_NUL ' + inspected.stdout.trim());
  return { root, file };
}
for (const [name, directory] of [['root/a\0suffix', false], ['root/dir\0suffix/', true]]) {
  test('I2 original ZIP ' + (directory ? 'directory' : 'file') + ' NUL names reject without sanitized output', async t => {
    const f = await nulFixture(t, name, directory), out = path.join(f.root, 'out');
    let failure; try { await pack.extractArchive(f.file, out, { kind: 'zip', root: 'root' }); } catch (error) { failure = error; }
    const emitted = await fs.readdir(out).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    t.diagnostic(JSON.stringify({ emitted, policyRejected: Boolean(failure) }));
    assert.deepEqual(emitted, [], 'sanitized entry must not be emitted');
    assert.match(failure?.message || '', /archive rejected: archive (?:unsafe path|ZIP name mismatch)/);
  });
}
for (const [name, directory] of [['META-INF/LICENSE\0suffix', false], ['META-INF/NOTICE\0suffix/', true]]) {
  test('I2 original JAR notice ' + (directory ? 'directory' : 'file') + ' NUL names reject before copies', async t => {
    const f = await nulFixture(t, name, directory), out = path.join(f.root, 'notices');
    const run = spawnSync('python3', [extractor, 'notices', f.file, out], { encoding: 'utf8' });
    const emitted = await fs.readdir(out).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    t.diagnostic(JSON.stringify({ exit: run.status, emitted }));
    assert.deepEqual(emitted, [], 'no sanitized or partial notice output');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /archive rejected: archive (?:unsafe path|ZIP name mismatch)/);
  });
}
test('I2 valid original ZIP directory/file and JAR notice names remain accepted', async t => {
  const root = await fixture(t), file = path.join(root, 'valid.zip');
  const make = spawnSync('python3', ['-c', "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('root/','');z.writestr('root/a','valid');z.close()", file]);
  assert.equal(make.status, 0); const out = path.join(root, 'out'); await pack.extractArchive(file, out, { kind: 'zip', root: 'root' });
  assert.equal(await fs.readFile(path.join(out, 'a'), 'utf8'), 'valid');
  const jar = path.join(root, 'valid.jar'); await fs.writeFile(jar, rawZip('META-INF/LICENSE'));
  const notices = path.join(root, 'notices'), result = spawnSync('python3', [extractor, 'notices', jar, notices], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(await fs.readFile(path.join(notices, '000.txt'), 'utf8'), 'fixture-notice');
});
