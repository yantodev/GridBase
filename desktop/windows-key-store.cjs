'use strict';
// Internal trusted main-host component only. The caller owns the already-bound
// native session; no paths/executable/session selection enter public load options.
const crypto = require('node:crypto');
const { failure } = require('../packages/local-engine/errors');
const { decodeKey, envelope, parse } = require('./key-envelope.cjs');
const BACKENDS = new Set(['windows-dpapi']);
const ALLOWED = new Set(['WINDOWS_PRIVATE_STORAGE_UNSUPPORTED','APP_NOT_READY','KEY_MISSING','KEY_INITIALIZING','KEY_UNAVAILABLE','KEY_BACKEND_UNAVAILABLE']);
const secure = bytes => Buffer.isBuffer(bytes) && bytes.subarray(0,3).equals(Buffer.from('v10'));
function createWindowsKeyProvider({ session, app, safeStorage, platform = process.platform }) {
  async function availability() {
    try {
      if (!safeStorage || typeof safeStorage.isAsyncEncryptionAvailable !== 'function' || typeof safeStorage.encryptStringAsync !== 'function' || typeof safeStorage.decryptStringAsync !== 'function' || await safeStorage.isAsyncEncryptionAvailable() !== true) throw Error();
    } catch { throw failure('KEY_BACKEND_UNAVAILABLE'); }
  }
  async function decrypt(bytes) {
    const { payload } = parse(bytes, { backends: BACKENDS, plaintext: false, strictAscii: true });
    await availability(); if (!secure(payload)) throw failure('KEY_BACKEND_UNAVAILABLE');
    const copy = Buffer.from(payload);
    try {
      const result = await safeStorage.decryptStringAsync(copy);
      if (!result || typeof result.shouldReEncrypt !== 'boolean') throw Error();
      return decodeKey(result.result);
    } finally { copy.fill(0); }
  }
  async function reopen(root) {
    const bytes = await session.readKey(root);
    try { return await decrypt(bytes); } finally { bytes.fill(0); }
  }
  function inspect(state, acquired = false) {
    if (state.alias) throw failure('KEY_UNAVAILABLE');
    if (state.claim && !acquired) throw failure('KEY_INITIALIZING');
    if (state.consent) throw failure(state.key ? 'KEY_UNAVAILABLE' : 'KEY_MISSING');
    if (!state.key && state.other) throw failure('KEY_MISSING');
  }
  return async function loadOrCreateKey(dataDir, options) {
    let root, raw, result, completed = false;
    try {
      if (platform !== 'win32') throw failure('WINDOWS_PRIVATE_STORAGE_UNSUPPORTED');
      if (!app || app.isReady() !== true) throw failure('APP_NOT_READY');
      if (!options || Object.keys(options).join(',') !== 'allowPlaintextFallback' || typeof options.allowPlaintextFallback !== 'boolean') throw failure('KEY_UNAVAILABLE');
      root = await session.openPrivateDirectory(dataDir);
      const state = await session.keyState(root); inspect(state);
      if (state.key) { result = await reopen(root); }
      else {
        await availability();
        let claim;
        try { claim = await session.beginKeyClaim(root); }
        catch (error) { throw failure(error.code === 'WINDOWS_INITIALIZING' ? 'KEY_INITIALIZING' : 'KEY_UNAVAILABLE'); }
        const acquired = await session.keyState(root); inspect(acquired, true);
        if (!acquired.claim) throw failure('KEY_INITIALIZING');
        if (acquired.key) result = await reopen(root);
        else {
          raw = crypto.randomBytes(32); let encrypted, verified, bytes;
          try {
            encrypted = await safeStorage.encryptStringAsync(raw.toString('base64url'));
            if (!secure(encrypted)) throw failure('KEY_BACKEND_UNAVAILABLE');
            if (encrypted.length > 60000 || encrypted.includes(raw) || encrypted.includes(Buffer.from(raw.toString('base64url')))) throw Error();
            const decoded = await safeStorage.decryptStringAsync(encrypted);
            if (!decoded || typeof decoded.shouldReEncrypt !== 'boolean') throw Error();
            verified = decodeKey(decoded.result); if (!verified.equals(raw)) throw Error();
            bytes = envelope(1, 'windows-dpapi', encrypted);
            await session.createKey(root, claim, bytes);
            result = await reopen(root);
            if (!result.equals(raw)) throw Error();
          } finally { verified?.fill(0); encrypted?.fill(0); bytes?.fill(0); }
        }
        // Only successful native persisted read + canonical decrypt may release
        // the exact claim held by this session. No unlink, rollback or retries.
        await session.finishKeyClaim(root, claim, true);
      }
      await session.closeRoot(root); root = undefined; completed = true; return result;
    } catch (error) { throw failure(ALLOWED.has(error.code) ? error.code : 'KEY_UNAVAILABLE'); }
    finally {
      raw?.fill(0); if (!completed) result?.fill(0);
      if (root !== undefined) await session.closeRoot(root).catch(() => {});
      // Session remains externally owned, including on error/failed claims.
    }
  };
}
module.exports = { createWindowsKeyProvider };
