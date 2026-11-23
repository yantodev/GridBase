'use strict';
const fs = require('node:fs/promises'); const path = require('node:path'); const crypto = require('node:crypto');
const { privateDirectory, readPrivateFile, exclusivePrivateFile, assertSupportedPlatform } = require('../packages/local-engine/private-paths');
const { strictJson } = require('../packages/local-engine/protocol'); const { failure } = require('../packages/local-engine/errors');
const KEY_FILE = 'credential-key.v1', CONSENT_FILE = 'key-consent.v1.json', CLAIM = '.credential-key.init';
const { BACKENDS, decodeKey, envelope, parse } = require('./key-envelope.cjs');
// Electron 45.4.1 pins Chromium 156.0.8078.100: POSIX fallback is v10,
// SecretService is v11 and SecretPortal is v12. Async availability is true
// even with fallback; the synchronous backend label alone is not sufficient.
function secureCiphertext(bytes) { return Buffer.isBuffer(bytes) && ['v11','v12'].includes(bytes.subarray(0, 3).toString('ascii')); }
const ALLOWED_ERRORS = new Set(['WINDOWS_PRIVATE_STORAGE_UNSUPPORTED','PRIVATE_PATH','APP_NOT_READY','KEY_MISSING','KEY_INITIALIZING','KEY_UNAVAILABLE','KEY_BACKEND_UNAVAILABLE','FALLBACK_CONSENT_REQUIRED']);

function createKeyProvider({ safeStorage, app, platform = process.platform }) {
  // Standard host-only dependency injection, not a production scheduling hook.
  // Electron 45.4.1 async API: availability -> boolean; decrypt ->
  // {result:string,shouldReEncrypt:boolean}. Never auto-rewrite on rotation.
  async function availability() {
    try {
      if (!safeStorage || typeof safeStorage.isAsyncEncryptionAvailable !== 'function' || typeof safeStorage.encryptStringAsync !== 'function' || typeof safeStorage.decryptStringAsync !== 'function') throw Error();
      const available = await safeStorage.isAsyncEncryptionAvailable();
      const backend = platform === 'linux' ? safeStorage.getSelectedStorageBackend() : '';
      return { available: available === true && BACKENDS.has(backend), backend };
    } catch { throw failure('KEY_BACKEND_UNAVAILABLE'); }
  }
  async function reopen(dir, bytes) {
    try {
      const { mode, backend, payload } = parse(bytes);
      if (mode === 2) {
        const consent = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(await readPrivateFile(path.join(dir, CONSENT_FILE), 128)), 128);
        if (!consent || Object.keys(consent).join(',') !== 'allowPlaintextFallback' || consent.allowPlaintextFallback !== true || platform !== 'linux') throw Error();
        return Buffer.from(payload);
      }
      const current = await availability();
      if (!current.available || current.backend !== backend) throw failure('KEY_BACKEND_UNAVAILABLE');
      if (!secureCiphertext(payload)) throw failure('KEY_BACKEND_UNAVAILABLE');
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(payload));
      if (!decrypted || typeof decrypted.shouldReEncrypt !== 'boolean') throw Error();
      // Rotation is not implicit protection migration: read only, retain bytes.
      return decodeKey(decrypted.result);
    } catch (error) { throw failure(error.code === 'KEY_BACKEND_UNAVAILABLE' ? error.code : 'KEY_UNAVAILABLE'); }
  }
  return async function loadOrCreateKey(dataDir, options) {
    let raw;
    try {
      assertSupportedPlatform(platform);
      if (!app || app.isReady() !== true) throw failure('APP_NOT_READY');
      if (!options || Object.keys(options).join(',') !== 'allowPlaintextFallback' || typeof options.allowPlaintextFallback !== 'boolean') throw failure('KEY_UNAVAILABLE');
      await privateDirectory(dataDir);
      const names = await fs.readdir(dataDir);
      // Refuse case aliases even on a case-sensitive test filesystem.
      for (const name of names) for (const canonical of [KEY_FILE, CONSENT_FILE, CLAIM]) if (name.toLowerCase() === canonical.toLowerCase() && name !== canonical) throw failure('KEY_UNAVAILABLE');
      if (names.includes(CLAIM)) throw failure('KEY_INITIALIZING');
      const file = path.join(dataDir, KEY_FILE);
      if (names.includes(KEY_FILE)) return await reopen(dataDir, await readPrivateFile(file, 65536).catch(() => { throw failure('KEY_UNAVAILABLE'); }));
      // Any non-consent artifact is established/unknown data: don't generate a
      // replacement key for SQLite sidecars or an existing workspace.
      if (names.length) throw failure('KEY_MISSING');
      const current = await availability();
      if (!current.available && (!options.allowPlaintextFallback || platform !== 'linux')) throw failure('FALLBACK_CONSENT_REQUIRED');
      try { await exclusivePrivateFile(path.join(dataDir, CLAIM), Buffer.from('initializing\n')); }
      catch (e) { if (e.code === 'EEXIST') throw failure('KEY_INITIALIZING'); throw e; }
      // A slow contender may acquire the claim only after the winner removed
      // it. Reopen that established key without leaving a new stale claim.
      const acquiredNames = await fs.readdir(dataDir);
      if (acquiredNames.includes(KEY_FILE)) {
        const key = await reopen(dataDir, await readPrivateFile(file, 65536));
        await fs.unlink(path.join(dataDir, CLAIM)); return key;
      }
      if (acquiredNames.some(n => n !== CLAIM)) throw failure('KEY_INITIALIZING');
      raw = crypto.randomBytes(32); let bytes;
      if (current.available) {
        const encrypted = await safeStorage.encryptStringAsync(raw.toString('base64url'));
        if (!secureCiphertext(encrypted)) throw failure('KEY_BACKEND_UNAVAILABLE');
        if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 60000 || encrypted.includes(raw) || encrypted.includes(Buffer.from(raw.toString('base64url')))) throw Error();
        const verified = await safeStorage.decryptStringAsync(encrypted);
        if (!verified || typeof verified.shouldReEncrypt !== 'boolean' || !decodeKey(verified.result).equals(raw)) throw Error();
        bytes = envelope(1, current.backend, encrypted);
      } else {
        await exclusivePrivateFile(path.join(dataDir, CONSENT_FILE), Buffer.from('{"allowPlaintextFallback":true}\n'));
        bytes = envelope(2, 'linux-plaintext', raw);
      }
      await exclusivePrivateFile(file, bytes);
      const key = await reopen(dataDir, await readPrivateFile(file, 65536));
      await fs.unlink(path.join(dataDir, CLAIM));
      return key;
    } catch (error) { throw failure(ALLOWED_ERRORS.has(error.code) ? error.code : 'KEY_UNAVAILABLE'); }
    finally { raw?.fill(0); /* Retain failed claim: partial initialization is fail-closed. */ }
  };
}
let defaultProvider;
async function loadOrCreateKey(dataDir, options) {
  if (!defaultProvider) {
    let electron; try { electron = require('electron'); } catch { throw failure('KEY_BACKEND_UNAVAILABLE'); }
    defaultProvider = createKeyProvider({ safeStorage: electron.safeStorage, app: electron.app });
  }
  return defaultProvider(dataDir, options);
}
module.exports = { loadOrCreateKey, createKeyProvider };
