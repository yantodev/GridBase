'use strict';
// Executable binary RPC fixture: synthetic inventory/POSIX storage, NOT WinAPI.
const fs = require('node:fs'); const path = require('node:path');
const p = require('../windows-protocol');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const decoder = new p.FrameDecoder(); let reads = 0, snapshot = 0, claimed = false, nextId = 100;
const bytes = b => Buffer.concat([p.u32(b.length), b]);
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const record = e => Buffer.concat([Buffer.from([e.kind]), p.string(e.path), p.u32(e.volume ?? 1), u64(e.index ?? 1), u64(e.size ?? 0), Buffer.from(e.sha256 ?? '0'.repeat(64), 'hex')]);
function trace(op, extra = {}) { if (config.trace) fs.appendFileSync(config.trace, JSON.stringify({ op, ...extra }) + '\n'); }
function keyPath(name) { return path.join(config.store, name); }
process.stdin.on('data', chunk => {
  for (const f of decoder.push(chunk)) {
    const r = new p.Reader(f.payload); let out = Buffer.alloc(0), status = config.statuses?.[f.code] ?? 0;
    trace(f.code);
    try {
      if (!status) switch (f.code) {
        case 2: r.text(); out = p.u32(++nextId); break;
        case 3: {
          r.u32(); snapshot++;
          if (config.lateKey && snapshot === 2) fs.writeFileSync(keyPath('credential-key.v1'), Buffer.from(config.lateKey, 'base64'));
          const names = fs.readdirSync(config.store);
          out = Buffer.from([names.includes('credential-key.v1'), names.includes('.credential-key.init'), names.includes('key-consent.v1.json'), names.some(n => !['credential-key.v1','.credential-key.init','key-consent.v1.json'].includes(n)), names.some(n => ['credential-key.v1','.credential-key.init','key-consent.v1.json'].some(c => n !== c && n.toLowerCase() === c))].map(Number)); break;
        }
        case 4: r.u32(); fs.writeFileSync(keyPath('.credential-key.init'), 'fixture-held', { flag: 'wx' }); claimed = true; out = p.u32(++nextId); break;
        case 5: r.u32(); out = bytes(fs.readFileSync(keyPath('credential-key.v1'))); break;
        case 6: {
          r.u32(); r.u32(); const b = r.take(r.u32());
          if (!claimed) throw Error();
          fs.writeFileSync(keyPath('credential-key.v1'), config.partial ? b.subarray(0, 8) : b, { flag: 'wx' });
          trace('envelope', { length: b.length, digest: require('node:crypto').createHash('sha256').update(b).digest('hex') }); break;
        }
        case 7: r.u32(); r.u32(); if (!claimed) throw Error(); fs.unlinkSync(keyPath('.credential-key.init')); claimed = false; break;
        case 8: r.text(); out = p.u32(201); break;
        case 9: {
          r.u32(); const relative = r.text(); const max = r.u32();
          let b = Buffer.from(config.files[relative] ?? '', 'base64');
          if (relative === 'engine/manifest.json' && ++reads > 1 && config.repeat) b = Buffer.from(config.repeat, 'base64');
          if (b.length > max && !config.ignoreMax) { status = 4; break; }
          out = bytes(b); break;
        }
        case 10: {
          r.u32(); const cursor = r.u32(); const page = config.pages.find(page => page.cursor === cursor);
          if (!page) { status = 7; break; }
          out = Buffer.concat([p.u32(page.next), p.u32(page.entries.length), ...page.entries.map(record)]); break;
        }
        case 11: r.u32(); break;
        case 12: r.u32(); break;
        case 13: break;
        default: status = 7;
      }
    } catch (e) { status = e.code === 'EEXIST' ? (f.code === 4 ? 3 : 1) : e.code === 'ENOENT' ? 2 : 6; }
    const frame = p.frame(status, f.id, status ? Buffer.alloc(0) : out);
    // Every response crosses an actual pipe with arbitrary binary splitting.
    process.stdout.write(frame.subarray(0, 3));
    setTimeout(() => { process.stdout.write(frame.subarray(3)); if (f.code === 13) process.exit(0); }, 1);
  }
});
process.stdin.on('end', () => process.exit(0));
