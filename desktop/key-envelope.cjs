'use strict';
// Shared GBKEY1 bytes/parser. Platform backend policy is explicit at the caller.
const crypto = require('node:crypto'); const { failure } = require('../packages/local-engine/errors');
const MAGIC = Buffer.from('GBKEY1\0');
const BACKENDS = new Set(['gnome_libsecret','kwallet','kwallet5','kwallet6']);
function decodeKey(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(text)) throw failure('KEY_UNAVAILABLE');
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== text) { bytes.fill(0); throw failure('KEY_UNAVAILABLE'); }
  return bytes;
}
function envelope(mode, backend, payload) {
  const tag = Buffer.from(backend, 'ascii'); const header = Buffer.alloc(6); header[0] = mode; header[1] = tag.length; header.writeUInt32BE(payload.length, 2);
  const content = Buffer.concat([MAGIC, header, tag, payload]);
  return Buffer.concat([content, crypto.createHash('sha256').update(content).digest()]);
}
function parse(bytes, { backends = BACKENDS, plaintext = true, strictAscii = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < MAGIC.length + 6 + 32 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw failure('KEY_UNAVAILABLE');
  const content = bytes.subarray(0, bytes.length - 32);
  if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(content).digest(), bytes.subarray(bytes.length - 32))) throw failure('KEY_UNAVAILABLE');
  const offset = MAGIC.length, mode = content[offset], n = content[offset + 1], size = content.readUInt32BE(offset + 2), start = offset + 6;
  const tag = content.subarray(start, start + n);
  if (strictAscii && tag.some(b => b > 127)) throw failure('KEY_UNAVAILABLE');
  const backend = tag.toString('ascii'), payload = content.subarray(start + n);
  if (![1,2].includes(mode) || size !== payload.length || content.length !== start + n + size || (mode === 1 ? !backends.has(backend) || size < 1 : !plaintext || backend !== 'linux-plaintext' || size !== 32)) throw failure('KEY_UNAVAILABLE');
  return { mode, backend, payload };
}
module.exports = { BACKENDS, decodeKey, envelope, parse };
