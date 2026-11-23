'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const p = require('../windows-protocol');
test('Windows RPC vector: root ID is little endian, split/coalesced input survives', () => {
  const frame = p.encodeRequest(3, 1, { root: 0x12345678 });
  assert.equal(frame.toString('hex'), '0c000000010003000100000078563412');
  const parser = new p.FrameDecoder();
  assert.deepEqual(parser.push(frame.subarray(0, 3)), []);
  const frames = parser.push(Buffer.concat([frame.subarray(3), frame]));
  assert.equal(frames.length, 2); assert.equal(frames[0].id, 1); assert.equal(frames[0].code, 3);
  parser.end();
});
test('strict schemas, UTF8, names, overflow, secret bounds and trailing response bytes', () => {
  for (const value of ['C:x', '\\\\server\\share', 'C:\\safe\\..\\x', 'C:\\safe\\NUL.txt', 'C:\\safe\\x:y', 'C:\\safe\\x.']) assert.throws(() => p.absolutePath(value));
  assert.equal(p.absolutePath('C:\\Users\\é\\safe'), 'C:\\Users\\é\\safe');
  for (const value of ['../x', 'a//x', 'a\\x', 'a/CON', 'a/with.']) assert.throws(() => p.relativePath(value));
  for (const value of ['\ud800', 'a\0b']) assert.throws(() => p.string(value));
  assert.throws(() => p.encodeRequest(3, 1, { root: 1, secret: 'do-not-reflect' }));
  assert.throws(() => p.encodeRequest(6, 1, { root: 1, claim: 2, bytes: Buffer.alloc(65537) }));
  for (const n of [0, 7, 2097153, 0xffffffff]) { const d = new p.FrameDecoder(); assert.throws(() => d.push(p.u32(n)), { code: 'WINDOWS_PROTOCOL' }); }
  const d = new p.FrameDecoder(); d.push(Buffer.from([8])); assert.throws(() => d.end());
  assert.throws(() => p.decodeResponse(3, { code: 0, payload: Buffer.from([1, 0, 0, 0, 0, 9]) }));
  assert.throws(() => p.decodeResponse(5, { code: 4, payload: Buffer.from('do-not-reflect') }), e => e.message === 'WINDOWS_PROTOCOL');
  assert.deepEqual(p.decodeResponse(3, { code: 0, payload: Buffer.from([1, 0, 0, 0, 0]) }), { key: true, claim: false, consent: false, other: false, alias: false });
});
