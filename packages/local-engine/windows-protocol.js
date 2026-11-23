'use strict';
// Internal Windows RPC v1. Never log frames. Does not authorize/activate Windows.
const MAX_FRAME = 2 * 1024 * 1024;
function fail(code = 'WINDOWS_PROTOCOL') { const e = new Error(code); e.code = code; return e; }
function uint(value, positive = false) { if (!Number.isInteger(value) || value < (positive ? 1 : 0) || value > 0xffffffff) throw fail(); return value; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32LE(uint(value)); return b; }
function frame(code, id, payload = Buffer.alloc(0)) {
  uint(id, true); if (!Number.isInteger(code) || code < 0 || code > 65535 || payload.length + 8 > MAX_FRAME) throw fail();
  const b = Buffer.alloc(payload.length + 12); b.writeUInt32LE(payload.length + 8); b.writeUInt16LE(1, 4); b.writeUInt16LE(code, 6); b.writeUInt32LE(id, 8); payload.copy(b, 12); return b;
}
class FrameDecoder {
  constructor() { this.buffer = Buffer.alloc(0); this.dead = false; }
  push(chunk) {
    if (this.dead || !Buffer.isBuffer(chunk)) throw fail();
    const out = []; let offset = 0;
    // Only buffer a single bounded frame, including for a huge coalesced chunk.
    while (offset < chunk.length) {
      const wanted = this.buffer.length < 4 ? 4 : this.buffer.readUInt32LE() + 4;
      const n = Math.min(wanted - this.buffer.length, chunk.length - offset);
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + n)]); offset += n;
      if (this.buffer.length < 4) continue;
      const length = this.buffer.readUInt32LE();
      if (length < 8 || length > MAX_FRAME) { this.dead = true; throw fail(); }
      if (this.buffer.length !== length + 4) continue;
      const b = this.buffer; this.buffer = Buffer.alloc(0);
      if (b.readUInt16LE(4) !== 1 || !b.readUInt32LE(8)) { this.dead = true; throw fail(); }
      out.push({ code: b.readUInt16LE(6), id: b.readUInt32LE(8), payload: b.subarray(12) });
    }
    return out;
  }
  end() { this.dead = true; if (this.buffer.length) throw fail(); }
}
function exact(v, names) { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...names].sort().join(',')) throw fail(); }
function string(v) {
  if (typeof v !== 'string' || v.includes('\0') || !v.isWellFormed() || v.length > 4096) throw fail();
  const b = Buffer.from(v); return Buffer.concat([u32(b.length), b]);
}
function component(v) { if (!v || v.length > 255 || v === '.' || v === '..' || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(v) || /[. ]$/.test(v) || /^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(v)) throw fail(); }
function relativePath(v) { string(v); v.split('/').forEach(component); return v; }
function absolutePath(v) { string(v); if (!/^[A-Z]:\\/.test(v)) throw fail(); if (v.length > 3) v.slice(3).split('\\').forEach(component); return v; }
function bytes(v, max) { if (!Buffer.isBuffer(v) || v.length > max) throw fail(); return Buffer.concat([u32(v.length), v]); }
const REQUEST_FIELDS = [null, [], ['path'], ['root'], ['root'], ['root'], ['root','claim','bytes'], ['root','claim'], ['path'], ['bundle','relative','max'], ['bundle','cursor'], ['root'], ['bundle'], []];
function encodeRequest(op, id, v = {}) {
  if (!REQUEST_FIELDS[op]) throw fail(); exact(v, REQUEST_FIELDS[op]); const parts = [];
  for (const name of REQUEST_FIELDS[op]) {
    const value = v[name];
    if (name === 'path') parts.push(string(absolutePath(value)));
    else if (name === 'relative') parts.push(string(relativePath(value)));
    else if (name === 'bytes') parts.push(bytes(value, 65536));
    else { uint(value, name !== 'cursor'); if (name === 'max' && value > 1048576) throw fail(); parts.push(u32(value)); }
  }
  return frame(op, id, Buffer.concat(parts));
}
class Reader {
  constructor(b) { this.b = b; this.i = 0; }
  take(n) { if (!Number.isInteger(n) || n < 0 || n > this.b.length - this.i) throw fail(); const b = this.b.subarray(this.i, this.i + n); this.i += n; return b; }
  u32() { return this.take(4).readUInt32LE(); }
  text() { const b = this.take(this.u32()); let s; try { s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b); } catch { throw fail(); } string(s); return s; }
  done() { if (this.i !== this.b.length) throw fail(); }
}
const STATUS = Object.freeze(['OK','EXISTS','MISSING','INITIALIZING','UNSAFE','UNSUPPORTED','IO','PROTOCOL']);
function decodeResponse(op, response) {
  if (!REQUEST_FIELDS[op] || !Number.isInteger(response.code) || !STATUS[response.code]) throw fail();
  const r = new Reader(response.payload);
  if (response.code) { r.done(); throw fail('WINDOWS_' + STATUS[response.code]); }
  let out;
  if ([2,4,8].includes(op)) out = uint(r.u32(), true);
  else if (op === 1) { out = {}; for (const name of ['dataDir','tempDir','sessionDir']) out[name] = absolutePath(r.text()); }
  else if (op === 3) { out = {}; for (const name of ['key','claim','consent','other','alias']) { const n = r.take(1)[0]; if (n > 1) throw fail(); out[name] = !!n; } }
  else if ([5,9].includes(op)) { const n = r.u32(); if (n > (op === 5 ? 65536 : 1048576)) throw fail(); out = Buffer.from(r.take(n)); }
  else if (op === 10) {
    // next:u32, count:u32; each {kind:u8(1 dir/2 file), path:string,
    // volume:u32, index:u64le, size:u64le, sha256:32 (zero for dirs)}.
    const next = r.u32(), count = r.u32(); if (count > 256) throw fail(); const entries = [];
    for (let i = 0; i < count; i++) { const kind = r.take(1)[0]; if (![1,2].includes(kind)) throw fail(); const path = relativePath(r.text()), volume = r.u32(), index = r.take(8).readBigUInt64LE(), size = r.take(8).readBigUInt64LE(), sha256 = r.take(32).toString('hex'); if (kind === 1 && (size !== 0n || sha256 !== '0'.repeat(64))) throw fail(); entries.push(Object.freeze({ kind, path, volume, index, size, sha256 })); }
    out = { entries, next };
  }
  r.done(); return out;
}
module.exports = { MAX_FRAME, STATUS, fail, uint, u32, frame, FrameDecoder, encodeRequest, decodeResponse, Reader, string, exact, absolutePath, relativePath };
