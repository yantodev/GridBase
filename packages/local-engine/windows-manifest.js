'use strict';
// Host-only: session and bundleDir come from the trusted installed host. The
// native helper's own inventory hash does not authenticate that bootstrap root.
const path = require('node:path').win32; const crypto = require('node:crypto');
const { strictJson } = require('./protocol'); const { failure } = require('./errors');
const { exact, absolutePath, relativePath, uint } = require('./windows-protocol');
const HELPERS = ['engine/native/win32-x64/gridbase-private-files.exe', 'engine/native/win32-x64/gridbase-launch-owned.exe'];
const FIXTURES = /^(?:(?:native|lifetime|security|identity|knownfolder|job)-fixture|codec-test|launch-json-test|gridbase-launch-owned-instrumented)\.exe$/i;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const text = b => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function relative(name) { relativePath(name); if (name.includes(';')) throw Error(); return name; }
async function loadWindowsManifest(session, bundleDir) {
  let bundle;
  try {
    absolutePath(bundleDir); if (bundleDir.includes(';')) throw Error();
    bundle = await session.openBundle(bundleDir);
    try {
      const source = await session.readBundleFile(bundle, 'engine/manifest.json', 1048576);
      if (!Buffer.isBuffer(source) || source.length > 1048576) throw Error();
      const m = strictJson(text(source), 1048576);
      exact(m, ['schema','protocol','version','platform','arch','java','resources','classpath','files']);
      if (m.schema !== 1 || m.protocol !== 1 || typeof m.version !== 'string' || !SEMVER.test(m.version) || m.platform !== 'win32' || m.arch !== 'x64' || !Array.isArray(m.classpath) || !m.classpath.length || m.classpath.length > 1024 || !Array.isArray(m.files) || !m.files.length || m.files.length > 20000) throw Error();
      relative(m.java); relative(m.resources); m.classpath.forEach(relative);
      if (new Set(m.classpath.map(n => n.toLowerCase())).size !== m.classpath.length) throw Error();
      const listed = new Map(), aliases = new Map();
      function alias(name) {
        let prefix = '';
        for (const part of name.split('/')) { prefix += (prefix ? '/' : '') + part; const lower = prefix.toLowerCase(); if (aliases.has(lower) && aliases.get(lower) !== prefix) throw Error(); aliases.set(lower, prefix); }
      }
      for (const f of m.files) {
        exact(f, ['path','sha256']); relative(f.path); alias(f.path);
        if (FIXTURES.test(f.path.split('/').at(-1))) throw Error();
        if (f.path === 'engine/manifest.json' || listed.has(f.path) || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) throw Error();
        listed.set(f.path, f.sha256);
      }
      for (const name of [m.java, m.resources + '/VERSION', ...HELPERS]) if (!listed.has(name)) throw Error();
      const scanned = new Map(), identities = new Set(), cursors = new Set([0]); let cursor = 0, files = 0, pages = 0;
      do {
        if (++pages > 40000) throw Error();
        const page = await session.scanBundlePage(bundle, cursor);
        exact(page, ['entries','next']); uint(page.next);
        if (!Array.isArray(page.entries) || page.entries.length > 256 || !page.entries.length) throw Error();
        if (page.next !== 0 && cursors.has(page.next)) throw Error(); cursors.add(page.next);
        for (const e of page.entries) {
          exact(e, ['kind','path','volume','index','size','sha256']); relative(e.path); alias(e.path); uint(e.volume);
          if (scanned.size >= 40000 || scanned.has(e.path) || ![1,2].includes(e.kind) || typeof e.index !== 'bigint' || e.index <= 0n || e.index > 0xffffffffffffffffn || typeof e.size !== 'bigint' || e.size < 0n || e.size > 0xffffffffffffffffn || typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) throw Error();
          const identity = e.volume + ':' + e.index.toString(); if (identities.has(identity)) throw Error(); identities.add(identity);
          if (e.kind === 1) { if (e.size !== 0n || e.sha256 !== '0'.repeat(64)) throw Error(); }
          else {
            if (++files > 20000) throw Error();
            if (e.path === 'engine/manifest.json') { if (e.size !== BigInt(source.length) || e.sha256 !== hash(source)) throw Error(); }
            else { if (listed.get(e.path) !== e.sha256) throw Error(); listed.delete(e.path); }
          }
          scanned.set(e.path, e);
        }
        cursor = page.next;
      } while (cursor !== 0);
      if (listed.size || scanned.get('engine/manifest.json')?.kind !== 2) throw Error();
      for (const name of scanned.keys()) {
        const parts = name.split('/'); parts.pop(); let parent = '';
        for (const part of parts) { parent += (parent ? '/' : '') + part; if (scanned.get(parent)?.kind !== 1) throw Error(); }
      }
      for (const name of [m.resources, m.resources + '/public']) if (scanned.get(name)?.kind !== 1) throw Error();
      for (const name of [m.java, ...HELPERS, m.resources + '/VERSION']) if (scanned.get(name)?.kind !== 2) throw Error();
      for (const name of m.classpath) { const kind = scanned.get(name)?.kind; if (kind !== 1 && !(kind === 2 && name.endsWith('.jar'))) throw Error(); }
      const versionBytes = await session.readBundleFile(bundle, m.resources + '/VERSION', 128);
      if (versionBytes.length > 128 || ![m.version, m.version + '\n', m.version + '\r\n'].includes(text(versionBytes)) || scanned.get(m.resources + '/VERSION').size !== BigInt(versionBytes.length) || scanned.get(m.resources + '/VERSION').sha256 !== hash(versionBytes)) throw Error();
      if (!(await session.readBundleFile(bundle, 'engine/manifest.json', 1048576)).equals(source)) throw Error();
      return Object.freeze({ version: m.version, java: path.join(bundleDir, m.java), resources: path.join(bundleDir, m.resources), classpath: Object.freeze(m.classpath.map(n => path.join(bundleDir, n))) });
    } finally { await session.closeBundle(bundle); }
  } catch { throw failure('INVALID_MANIFEST'); }
}
module.exports = { loadWindowsManifest };
