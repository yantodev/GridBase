'use strict';
const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const childSource = String.raw`
const fs = require('node:fs'); const http = require('node:http'); const path = require('node:path');
const mode = MODE;
const cwd = process.cwd(); fs.writeFileSync(path.join(cwd, 'child.pid'), '' + process.pid);
let input = ''; let boot; let server; let writes = 0;
process.stdin.on('data', chunk => { input += chunk; if (!boot && input.includes('\n')) { boot = JSON.parse(input.split('\n')[0]); run(); } });
process.stdin.on('end', () => { if (mode !== 'ignore-eof') { if (server) server.close(() => process.exit(0)); else process.exit(0); } });
function run() {
  if (mode === 'exit') return process.exit(3);
  if (mode === 'no-ready') return;
  if (mode === 'malformed') return process.stdout.write('synthetic-secret-not-json\n');
  if (mode === 'oversize') return process.stdout.write('x'.repeat(8193));
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'GridBase-Local ' + boot.capability || req.headers.origin || req.headers.cookie) { res.writeHead(401); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json'); res.setHeader('authorization', 'transport-secret'); res.setHeader('set-cookie', 'unsafe'); res.setHeader('x-request-id', '12345678-1234-1234-1234-123456789abc');
    if (mode === 'audit-warning') res.setHeader('X-GridBase-Audit-Warning', ['/api/connections','/api/query'].includes(req.url) ? 'incomplete' : 'secret-invalid-warning');
    if (req.url === '/healthz') { res.end(JSON.stringify({ status: mode === 'bad-health' ? 'bad' : 'ok' })); return; }
    if (req.url === '/api/auth/session') { res.end(JSON.stringify({ authenticated: true, mode: 'local', user: { provider: 'local', id: 'local:12345678-1234-1234-1234-123456789abc' }, capabilities: { auditAdmin: mode === 'admin' } })); return; }
    if (req.url === '/api/query') {
      req.resume(); req.on('end', () => {
        writes++; fs.appendFileSync(path.join(cwd, 'writes'), 'submitted\n');
        if (mode === 'drop-write') req.socket.destroy();
        else if (mode === 'hang-write') { /* cancellation/timeout must not retry */ }
        else if (mode === 'exit-write') process.exit(4);
        else res.end(JSON.stringify({ writes }));
      }); return;
    }
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:' + REDIRECT_PORT + '/leak' }); res.end(); return; }
    if (mode === 'large') { res.writeHead(200); for (let i=0;i<17;i++) res.write(Buffer.alloc(1024*1024, 97)); res.end(); return; }
    if (mode === 'reflect') { res.end(JSON.stringify({ capability: boot.capability, key: boot.credentialKey })); return; }
    res.end(JSON.stringify({ env: Object.keys(process.env).sort(), argv: process.argv.slice(2), cwd, account: req.headers['x-gridbase-account'], writes }));
  }).listen(0, '127.0.0.1', () => {
    const ready = { event: 'ready', protocol: 1, version: '1.4.0', pid: process.pid, port: server.address().port };
    if (mode === 'protocol') ready.protocol = 2;
    if (mode === 'pid') ready.pid++;
    if (mode === 'version') ready.version = '9.9.9';
    process.stdout.write(JSON.stringify(ready) + '\n');
    if (mode === 'extra') process.stdout.write('extra\n');
  });
}
`;
async function writeManifest(bundle, java, classpath = ['classes']) {
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel + '/');
      else if (rel !== 'engine/manifest.json') files.push({ path: rel, sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(dir, entry.name))).digest('hex') });
    }
  }
  await walk(bundle);
  const m = { schema: 1, protocol: 1, version: '1.4.0', platform: process.platform, arch: process.arch, java, resources: 'resources', classpath, files };
  await fs.mkdir(path.join(bundle, 'engine'), { recursive: true }); await fs.writeFile(path.join(bundle, 'engine/manifest.json'), JSON.stringify(m)); return m;
}
async function fixture(t, mode = 'ready', port = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-supervisor 空 $() ')); await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundleDir = path.join(root, 'bundle'); const dataDir = path.join(root, 'data'); const tempDir = path.join(root, 'temp');
  await fs.mkdir(path.join(bundleDir, 'resources/public'), { recursive: true }); await fs.mkdir(path.join(bundleDir, 'classes'));
  await fs.writeFile(path.join(bundleDir, 'resources/VERSION'), '1.4.0\n'); await fs.writeFile(path.join(bundleDir, 'resources/public/index.html'), 'fixture');
  const script = childSource.replace('MODE', JSON.stringify(mode)).replace('REDIRECT_PORT', '' + port);
  await fs.writeFile(path.join(bundleDir, 'child.cjs'), script);
  // Actual ELF stand-in, then exec Node in place: production launcher rejects
  // shebang indirection. All code/paths here are disposable test fixtures.
  const c = path.join(root, 'fixture.c');
  await fs.writeFile(c, '#include <unistd.h>\n#include <stdlib.h>\nint main(int argc,char **argv){char **a=calloc((size_t)argc+2,sizeof(char*));if(!a)return 9;a[0]=' + JSON.stringify(process.execPath) + ';a[1]=' + JSON.stringify(path.join(bundleDir, 'child.cjs')) + ';for(int i=1;i<argc;i++)a[i+1]=argv[i];execv(a[0],a);return 9;}\n');
  const compiled = spawnSync('/usr/bin/cc', ['-O2',c,'-o',path.join(bundleDir, 'java fixture 空')], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8' });
  if (compiled.status !== 0) throw Error('Fixture ELF compile failed: ' + compiled.stderr);
  await fs.chmod(path.join(bundleDir, 'java fixture 空'), 0o700);
  await require('../native/build.cjs').buildLauncher(path.join(bundleDir, 'engine/native/gridbase-launcher'));
  await writeManifest(bundleDir, 'java fixture 空');
  return { root, bundleDir, dataDir, tempDir, clientKind: 'desktop', credentialKey: Buffer.alloc(32, 7) };
}
const options = f => ({ bundleDir: f.bundleDir, dataDir: f.dataDir, tempDir: f.tempDir, clientKind: f.clientKind, credentialKey: f.credentialKey });
async function waitFile(file, timeout = 5000) { const end = Date.now() + timeout; while (Date.now() < end) { try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; } await new Promise(r => setTimeout(r, 10)); } throw Error('Fixture barrier deadline'); }
module.exports = { fixture, writeManifest, options, waitFile };
