'use strict';
// Internal PartB seam; installedBundle is a trusted host bootstrap root, not
// workspace/renderer input. RPC transport DI is intentionally separate from
// production executable selection. This file does NOT enable Windows startup.
const { spawn, spawnSync } = require('node:child_process'); const path = require('node:path');
const { FrameDecoder, encodeRequest, decodeResponse, fail, absolutePath, uint } = require('./windows-protocol');
class RpcTransport {
  constructor(child, { timeout = 10000, total = 120000 } = {}) {
    if (!Number.isFinite(timeout) || timeout < 1 || !Number.isFinite(total) || total < 1) throw fail();
    this.child = child; this.timeout = timeout; this.deadline = Date.now() + total; this.next = 1; this.pending = null; this.dead = false;
    this.closeObserved = false; this.shutdown = null;
    this.closed = new Promise(resolve => child.once('close', () => {
      this.closeObserved = true;
      resolve();
      this.stop('WINDOWS_EOF');
    }));
    const decoder = new FrameDecoder();
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      try { for (const frame of decoder.push(chunk)) {
        const pending = this.pending; if (!pending || frame.id !== pending.id) throw fail();
        // Clear the outstanding slot only after schema validation succeeds.
        let result; try { result = decodeResponse(pending.op, frame); }
        catch (e) { if (e.code === 'WINDOWS_PROTOCOL') throw e; this.pending = null; clearTimeout(pending.timer); pending.reject(e); continue; }
        this.pending = null; clearTimeout(pending.timer); pending.resolve(result);
      } } catch { this.stop('WINDOWS_PROTOCOL'); }
    });
    child.stdout.on('end', () => { try { decoder.end(); } catch {} this.stop('WINDOWS_EOF'); });
    child.on('error', () => this.stop('WINDOWS_IO')); child.stdin.on('error', () => this.stop('WINDOWS_IO'));
    this.sessionTimer = setTimeout(() => this.stop('WINDOWS_TIMEOUT'), total);
  }
  request(op, value = {}) {
    if (this.dead) return this.stop('WINDOWS_CLOSED').then(() => { throw fail('WINDOWS_CLOSED'); });
    if (this.pending) return Promise.reject(fail('WINDOWS_BUSY'));
    let b; const id = this.next++;
    try { if (id > 0xffffffff) throw fail(); b = encodeRequest(op, id, value); }
    catch { return this.stop('WINDOWS_PROTOCOL').then(() => { throw fail(); }); }
    return new Promise((resolve, reject) => {
      const remaining = Math.min(op === 10 ? Math.max(this.timeout, 60000) : this.timeout, this.deadline - Date.now());
      this.pending = { id, op, resolve, reject, timer: setTimeout(() => this.stop('WINDOWS_TIMEOUT'), Math.max(1, remaining)) };
      try { this.child.stdin.write(b, () => b.fill(0)); }
      catch { b.fill(0); this.stop('WINDOWS_IO'); }
    });
  }
  stop(code) {
    if (this.shutdown) return this.shutdown;
    this.dead = true;
    clearTimeout(this.sessionTimer);
    const pending = this.pending;
    this.pending = null;
    if (pending) clearTimeout(pending.timer);
    // Install the idempotent promise BEFORE triggering any child/pipe events.
    // kill's return value is never exit proof. Only ChildProcess close releases
    // terminal failures to callers; creation is never retried or rolled back.
    this.shutdown = this.closed.then(() => { pending?.reject(fail(code)); });
    this.child.stdin.destroy();
    if (!this.closeObserved) this.child.kill('SIGKILL');
    return this.shutdown;
  }
  abort() { return this.stop('WINDOWS_CLOSED'); }
}
class HostPrivateFilesSession {
  // Only fixed desktop bootstrap before Electron app-ready. No generic sync RPC.
  static prepareDesktopSync(installedBundle) {
    if(process.platform!=='win32')throw fail('WINDOWS_UNSUPPORTED');absolutePath(installedBundle);
    const env={};for(const k of ['SystemRoot','WINDIR'])if(process.env[k])env[k]=process.env[k];
    const helper=path.win32.join(installedBundle,'engine','native','win32-x64','gridbase-private-files.exe');
    const result=spawnSync(helper,[],{shell:false,windowsHide:true,cwd:installedBundle,env,input:encodeRequest(1,1),timeout:10000,maxBuffer:2*1024*1024+4,stdio:['pipe','pipe','pipe']});
    try{if(result.error||result.status!==0)throw fail();const d=new FrameDecoder(),frames=d.push(result.stdout);d.end();if(frames.length!==1||frames[0].id!==1)throw fail();return decodeResponse(1,frames[0]);}catch{throw fail('WINDOWS_PREPARE_FAILED');}
  }
  static start(installedBundle) {
    if (process.platform !== 'win32') throw fail('WINDOWS_UNSUPPORTED'); absolutePath(installedBundle);
    const helper = path.win32.join(installedBundle, 'engine','native','win32-x64','gridbase-private-files.exe');
    const env = {}; for (const k of ['SystemRoot','WINDIR']) if (process.env[k]) env[k] = process.env[k];
    const child = spawn(helper, [], { shell: false, windowsHide: true, cwd: installedBundle, env, stdio: ['pipe','pipe','pipe'] });
    return new HostPrivateFilesSession(new RpcTransport(child));
  }
  constructor(rpc) { this.rpc = rpc; this.roots = new Set(); this.bundles = new Set(); this.claims = new Map(); this.issued = new Set(); }
  issue(id) { uint(id,true); if(this.issued.has(id))throw fail();this.issued.add(id);return id; }
  own(set, id) { if (!set.has(id)) throw fail(); return id; }
  prepareDesktop() { return this.rpc.request(1); }
  async openPrivateDirectory(path) { const id = this.issue(await this.rpc.request(2, { path })); this.roots.add(id); return id; }
  keyState(root) { return this.rpc.request(3, { root: this.own(this.roots, root) }); }
  async beginKeyClaim(root) { this.own(this.roots, root); const id = this.issue(await this.rpc.request(4, { root })); this.claims.set(id, { root, read: false }); return id; }
  async readKey(root) { this.own(this.roots, root); const bytes = await this.rpc.request(5, { root }); for (const c of this.claims.values()) if (c.root === root) c.read = true; return bytes; }
  claim(root, claim) { this.own(this.roots, root); const c = this.claims.get(claim); if (!c || c.root !== root) throw fail(); return c; }
  createKey(root, claim, bytes) { const c = this.claim(root, claim); c.read = false; return this.rpc.request(6, { root, claim, bytes }); }
  // decrypted=true is a trusted host assertion AFTER canonical decrypt/reopen;
  // native cannot prove DPAPI. PartB must not expose it through public IPC.
  async finishKeyClaim(root, claim, decrypted) { const c = this.claim(root, claim); if (decrypted !== true || !c.read) throw fail(); await this.rpc.request(7, { root, claim }); this.claims.delete(claim); }
  async openBundle(path) { const id = this.issue(await this.rpc.request(8, { path })); this.bundles.add(id); return id; }
  readBundleFile(bundle, relative, max) { return this.rpc.request(9, { bundle: this.own(this.bundles, bundle), relative, max }); }
  scanBundlePage(bundle, cursor = 0) { return this.rpc.request(10, { bundle: this.own(this.bundles, bundle), cursor }); }
  async closeRoot(root) { this.own(this.roots, root); await this.rpc.request(11, { root }); this.roots.delete(root); for (const [id,c] of this.claims) if (c.root === root) this.claims.delete(id); }
  async closeBundle(bundle) { this.own(this.bundles, bundle); await this.rpc.request(12, { bundle }); this.bundles.delete(bundle); }
  async close() { try { await this.rpc.request(13); } finally { await this.rpc.abort(); } }
}
module.exports = { RpcTransport, HostPrivateFilesSession };
