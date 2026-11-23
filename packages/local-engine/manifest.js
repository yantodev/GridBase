'use strict';
const fs = require('node:fs/promises'); const path = require('node:path'); const crypto = require('node:crypto');
const { strictJson } = require('./protocol'); const { failure } = require('./errors');
const { checkComponents, readRegularFile, openRegular, stable } = require('./private-paths');
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const LAUNCHER = 'engine/native/gridbase-launcher';
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function requireKeys(obj, keys) { if (!obj || Array.isArray(obj) || typeof obj !== 'object' || Object.keys(obj).sort().join(',') !== [...keys].sort().join(',')) throw Error(); }
function relative(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\\:*?"<>|\x00-\x1f\x7f]/.test(value) || value.startsWith('/')) throw Error();
  for (const component of value.split('/')) if (!component || component === '.' || component === '..' || /[. ]$/.test(component) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)) throw Error();
  return value;
}
async function hash(target) {
  const { handle, st } = await openRegular(target); const digest = crypto.createHash('sha256'); const buffer = Buffer.alloc(128 * 1024);
  try { for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; digest.update(buffer.subarray(0, bytesRead)); } await stable(target, handle, st); return digest.digest('hex'); }
  finally { await handle.close(); }
}
async function loadManifest(bundleDir) {
  if (process.platform === 'win32') {
    let session;
    try {
      session = require('./windows-private-files').HostPrivateFilesSession.start(bundleDir);
      return await require('./windows-manifest').loadWindowsManifest(session, bundleDir);
    } catch { throw failure('INVALID_MANIFEST'); }
    finally { if (session) await session.close().catch(() => {}); }
  }
  try {
    if (typeof bundleDir !== 'string' || bundleDir.includes(path.delimiter)) throw Error();
    await checkComponents(bundleDir); if (!(await fs.lstat(bundleDir)).isDirectory()) throw Error();
    const source = await readRegularFile(path.join(bundleDir, 'engine/manifest.json'), 1024 * 1024);
    const m = strictJson(utf8(source), 1024 * 1024);
    requireKeys(m, ['schema','protocol','version','platform','arch','java','resources','classpath','files']);
    if (m.schema !== 1 || m.protocol !== 1 || !SEMVER.test(m.version) || !['linux','win32'].includes(m.platform) || m.platform !== process.platform || m.arch !== 'x64' || m.arch !== process.arch || !Array.isArray(m.classpath) || !m.classpath.length || m.classpath.length > 1024 || !Array.isArray(m.files) || !m.files.length || m.files.length > 20000) throw Error();
    relative(m.java); relative(m.resources); m.classpath.forEach(relative);
    if (new Set(m.classpath.map(x => x.toLowerCase())).size !== m.classpath.length) throw Error();
    const inventory = new Map(), aliases = new Map();
    function alias(name) {
      let prefix = '';
      for (const part of name.split('/')) { prefix += (prefix ? '/' : '') + part; const lower = prefix.toLowerCase(); if (aliases.has(lower) && aliases.get(lower) !== prefix) throw Error(); aliases.set(lower, prefix); }
    }
    for (const file of m.files) {
      requireKeys(file, ['path','sha256']); relative(file.path); alias(file.path);
      if (file.path === 'engine/manifest.json' || inventory.has(file.path) || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw Error();
      inventory.set(file.path, file.sha256);
    }
    if (!inventory.has(m.java) || !inventory.has(m.resources + '/VERSION')) throw Error();
    if (process.platform === 'linux' && !inventory.has(LAUNCHER)) throw Error();
    // Inventory the full distribution, not just the selected classpath: runtime
    // libraries loaded by the JVM must be regular, dereferenced, hashed files too.
    let entries = 0;
    async function walk(dir, prefix = '') {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (++entries > 40000) throw Error(); const name = prefix + entry.name; relative(name); alias(name);
        const target = path.join(dir, entry.name); const st = await fs.lstat(target);
        if (st.isSymbolicLink()) throw Error();
        if (st.isDirectory()) await walk(target, name + '/');
        else if (st.isFile() && st.nlink === 1) {
          if (name === 'engine/manifest.json') continue;
          if (!inventory.has(name) || await hash(target) !== inventory.get(name)) throw Error(); inventory.delete(name);
        } else throw Error();
      }
    }
    await walk(bundleDir); if (inventory.size) throw Error();
    const java = path.join(bundleDir, m.java), resources = path.join(bundleDir, m.resources);
    const launcher = process.platform === 'linux' ? path.join(bundleDir, LAUNCHER) : null;
    if (!(await fs.lstat(java)).isFile() || !(await fs.lstat(resources)).isDirectory() || !(await fs.lstat(path.join(resources, 'public'))).isDirectory()) throw Error();
    if (process.platform !== 'win32' && !((await fs.stat(java)).mode & 0o111)) throw Error();
    for (const executable of [java, launcher].filter(Boolean)) {
      const st = await fs.lstat(executable);
      if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o6000) || !(st.mode & 0o111)) throw Error();
    }
    const version = utf8(await readRegularFile(path.join(resources, 'VERSION'), 128));
    if (version !== m.version && version !== m.version + '\n' && version !== m.version + '\r\n') throw Error();
    for (const entry of m.classpath) { const st = await fs.lstat(path.join(bundleDir, entry)); if (!st.isDirectory() && !(st.isFile() && entry.endsWith('.jar'))) throw Error(); }
    // Detect concurrent manifest replacement during inventory validation.
    if (!(await readRegularFile(path.join(bundleDir, 'engine/manifest.json'), 1024 * 1024)).equals(source)) throw Error();
    return Object.freeze({ version: m.version, java, launcher, resources, classpath: Object.freeze(m.classpath.map(x => path.join(bundleDir, x))) });
  } catch { throw failure('INVALID_MANIFEST'); }
}
module.exports = { loadManifest };
