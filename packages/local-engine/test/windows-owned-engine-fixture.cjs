'use strict';
// Real staged wrapper + authenticated synthetic HTTP engine, NOT Java/WinAPI.
const readline = require('node:readline'); const http = require('node:http'); const fs = require('node:fs');
const mode = process.argv[2], trace = process.argv[3]; let phase = 0, boot, server;
const javaPid = process.pid + 100000;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const v = JSON.parse(line);
  if (phase++ === 0) setTimeout(() => send({ event: 'HostBound', protocol: 1, hostPid: v.hostPid }), mode === 'deadline' ? 90 : 0);
  else if (phase === 2) setTimeout(() => send({ event: 'Owned', protocol: 1, javaPid }), mode === 'deadline' ? 90 : 0);
  else if (phase === 3) { if (v.event !== 'Commit') process.exit(9); }
  else if (phase === 4) {
    boot = v;
    if (mode === 'exit') return process.exit(4);
    server = http.createServer((req,res) => {
      fs.appendFileSync(trace, JSON.stringify({ method: req.method, path: req.url, actor: req.headers['x-gridbase-account'] ?? null, authenticated: req.headers.authorization === 'GridBase-Local ' + boot.capability }) + '\n');
      if (req.headers.authorization !== 'GridBase-Local ' + boot.capability) { res.writeHead(401); res.end('{}'); return; }
      res.setHeader('content-type','application/json'); res.setHeader('x-request-id','12345678-1234-1234-1234-123456789abc'); res.setHeader('set-cookie','synthetic-secret'); res.setHeader('authorization','synthetic-secret');
      res.setHeader('x-gridbase-audit-warning',req.url === '/api/health' ? 'secret-invalid' : 'incomplete');
      if (req.url === '/healthz') { if (mode === 'deadline') setTimeout(() => res.end('{"status":"ok"}'),150); else res.end(mode === 'bad-health' ? '{"status":"bad"}' : '{"status":"ok"}'); return; }
      if (req.url === '/api/auth/session') { res.end(JSON.stringify({ authenticated: mode !== 'bad-auth', mode: 'local', user: { provider: 'local', id: 'local:12345678-1234-1234-1234-123456789abc' }, capabilities: { auditAdmin: mode === 'admin' } })); return; }
      if (req.url === '/api/query') { req.resume(); req.on('end', () => { if (mode === 'exit-write') process.exit(8); else if (mode === 'drop-write') req.socket.destroy(); else res.end('{"writes":1}'); }); return; }
      if (mode === 'reflect') { res.end(JSON.stringify({ capability: boot.capability, key: boot.credentialKey })); return; }
      if (mode === 'redirect') { res.writeHead(302,{location:'http://127.0.0.1:1/secret'}); res.end('{}'); return; }
      res.end('{}');
    }).listen(0,'127.0.0.1',() => {
      const ready = { event:'ready', protocol:1, version:mode==='version'?'9.9.9':'1.4.0', pid:mode==='pid'?process.pid:javaPid, port:server.address().port };
      if (mode === 'reflection-ready') return process.stdout.write(boot.credentialKey + '\n');
      const b = Buffer.from(JSON.stringify(ready)+'\n'); process.stdout.write(b.subarray(0,9)); setTimeout(() => { process.stdout.write(b.subarray(9)); if(mode==='extra') process.stdout.write('extra\n'); },2);
    });
  } else process.exit(7);
});
lines.on('close', () => {
  if (mode !== 'wrapper-only') process.stderr.write(JSON.stringify({ event:'JavaExited',protocol:1,javaPid,code:17,forced:false })+'\n');
  if (server) server.closeAllConnections();
  if (server) server.close(() => process.exit(0)); else process.exit(0);
});
