'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os'); const { spawn, spawnSync } = require('node:child_process'); const { once } = require('node:events');
const { waitFile } = require('./fixture.cjs');
const SOURCE = path.resolve(__dirname, '../native/build.cjs');
function javaArgs(root) { return ['--add-modules','jdk.httpserver','-Djava.io.tmpdir=' + path.join(root, 'temp'),'-Dorg.sqlite.tmpdir=' + path.join(root, 'temp'),'-cp',path.join(root, 'classes'),'com.peentar.thriftquery.LocalEngineMain','--resources',path.join(root, 'resources'),'--data-dir',path.join(root, 'data'),'--temp-dir',path.join(root, 'temp')]; }
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-fix1-launcher 空 ')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { buildLauncher } = require(SOURCE); const launcher = path.join(root, 'launcher'); await buildLauncher(launcher);
  return { root, launcher };
}
test('native launcher build is deterministic and invalid authority/argv/exec/privileged mode fail closed', async t => {
  const f = await setup(t); const { buildLauncher } = require(SOURCE); const copy = path.join(f.root, 'launcher2'); await buildLauncher(copy); assert.deepEqual(await fs.readFile(f.launcher), await fs.readFile(copy));
  const java = path.join(f.root, 'java'); await fs.copyFile(process.execPath, java); const args = javaArgs(f.root);
  const denied = [[], ['0', java, ...args], ['01', java, ...args], ['-1', java, ...args], ['99999999999999999999', java, ...args], [String(process.pid + 100000), java, ...args], [String(process.pid), 'relative', ...args], [String(process.pid), path.join(f.root, 'missing'), ...args], [String(process.pid), java, ...args, '--extra'], [String(process.pid), java, ...args.map(v => v === 'jdk.httpserver' ? 'other' : v)]];
  for (const input of denied) { const r = spawnSync(f.launcher, input, { env: { LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 5000 }); assert.equal(r.status, 126); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'Local engine launch refused.\n'); }
  await fs.chmod(java, 0o4700); let r = spawnSync(f.launcher, [String(process.pid),java,...args], { env: {}, encoding: 'utf8' }); assert.equal(r.status, 126); assert.equal(r.stderr, 'Local engine launch refused.\n');
  await fs.chmod(java, 0o2700); r = spawnSync(f.launcher, [String(process.pid),java,...args], { env: {}, encoding: 'utf8' }); assert.equal(r.status, 126);
  await fs.chmod(java, 0o700); const link = path.join(f.root, 'link'); await fs.symlink(java, link); r = spawnSync(f.launcher, [String(process.pid),link,...args], { env: {}, encoding: 'utf8' }); assert.equal(r.status, 126);
  await fs.writeFile(java, Buffer.from([0x7f,0x45,0x4c,0x46])); r = spawnSync(f.launcher, [String(process.pid),java,...args], { env: {}, encoding: 'utf8' }); assert.equal(r.status, 126); assert.equal(r.stderr, 'Local engine launch refused.\n');
});
test('native launcher refuses original expected parent already gone before it can arm', { timeout: 15000 }, async t => {
  const f = await setup(t); const wrapperSource = path.join(f.root, 'delayed.c'), wrapper = path.join(f.root, 'delayed');
  await fs.writeFile(wrapperSource, '#include <unistd.h>\n#include <stdlib.h>\nint main(int argc,char **argv){if(argc<4)return 9;while(access(argv[1],F_OK)!=0)usleep(1000);execv(argv[2],&argv[2]);return 9;}\n');
  const c = spawnSync('/usr/bin/cc', ['-O2',wrapperSource,'-o',wrapper], { encoding: 'utf8' }); assert.equal(c.status, 0, c.stderr);
  const gate = path.join(f.root, 'release'), pidFile = path.join(f.root, 'pid'); const code = `const fs=require('node:fs');const{spawn}=require('node:child_process');const c=spawn(process.argv[1],[process.argv[2],process.argv[3],String(process.pid),process.execPath,...JSON.parse(process.argv[5])],{stdio:['ignore',1,2]});fs.writeFileSync(process.argv[4],String(c.pid));setInterval(()=>{},1000);`;
  const host = spawn(process.execPath, ['-e',code,wrapper,gate,f.launcher,pidFile,JSON.stringify(javaArgs(f.root))], { env: { LANG: 'C.UTF-8' }, stdio: ['ignore','pipe','pipe'] }); let stdout = '', stderr = '';
  host.stdout.on('data', b => stdout += b); host.stderr.on('data', b => stderr += b); const closed = once(host, 'close'); let pid, start;
  try {
    pid = +(await waitFile(pidFile)); start = (await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19]; host.kill('SIGKILL'); await once(host, 'exit'); await fs.writeFile(gate, 'release'); await closed;
    assert.equal(stdout, ''); assert.equal(stderr, 'Local engine launch refused.\n');
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; }); if (stat) assert(stat.slice(stat.lastIndexOf(') ') + 2).startsWith('Z'));
  } finally { if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL'); if (pid && start) { const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null); if (stat && stat.split(') ')[1].split(' ')[19] === start && !stat.slice(stat.lastIndexOf(') ') + 2).startsWith('Z')) process.kill(pid, 'SIGKILL'); } }
});
test('native normal parent exec keeps PID/pipes/environment and kernel parent-death authority', async t => {
  const f = await setup(t); const source = path.join(f.root, 'probe.c'), probe = path.join(f.root, 'probe');
  await fs.writeFile(source, '#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\n#include <sys/prctl.h>\nint main(void){int s=0;char b[64];if(prctl(PR_GET_PDEATHSIG,&s)!=0||!fgets(b,sizeof(b),stdin))return 9;printf("%ld %ld %d %d %s %s",(long)getpid(),(long)getppid(),s,prctl(PR_GET_NO_NEW_PRIVS,0,0,0,0),getenv("LANG"),b);return 0;}\n');
  const compiled = spawnSync('/usr/bin/cc', ['-O2',source,'-o',probe], { encoding: 'utf8' }); assert.equal(compiled.status, 0, compiled.stderr);
  const child = spawn(f.launcher, [String(process.pid),probe,...javaArgs(f.root)], { env: { LANG: 'C.UTF-8' }, stdio: ['pipe','pipe','pipe'] }); let out = '', error = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => error += b); const closed = once(child, 'close'); child.stdin.end('synthetic-bootstrap\n');
  const [code, signal] = await closed; assert.equal(code, 0); assert.equal(signal, null); assert.equal(error, '');
  assert.equal(out, `${child.pid} ${process.pid} 9 1 C.UTF-8 synthetic-bootstrap\n`);
});
module.exports = { javaArgs };
test('native syscall denial or capability metadata refuses instead of insecure exec', async t => {
  const f = await setup(t), java = path.join(f.root, 'java'); await fs.copyFile(process.execPath, java);
  for (const [name, wrapper, flags] of [
    ['prctl', '#include <sys/prctl.h>\nint __wrap_prctl(int option,...){(void)option;return -1;}\n', ['-Wl,--wrap=prctl']],
    ['death-prctl', '#include <sys/prctl.h>\n#include <stdarg.h>\nint __real_prctl(int,...);int __wrap_prctl(int option,...){if(option==PR_SET_PDEATHSIG)return -1;return __real_prctl(option,1L,0L,0L,0L);}\n', ['-Wl,--wrap=prctl']],
    ['capability', '#include <sys/types.h>\nssize_t __wrap_getxattr(const char*p,const char*n,void*v,size_t s){(void)p;(void)n;(void)v;(void)s;return 0;}\n', ['-Wl,--wrap=getxattr']],
    ['xattr-denied', '#include <sys/types.h>\n#include <errno.h>\nssize_t __wrap_getxattr(const char*p,const char*n,void*v,size_t s){(void)p;(void)n;(void)v;(void)s;errno=EACCES;return -1;}\n', ['-Wl,--wrap=getxattr']],
    ['post-arm-parent', '#include <sys/types.h>\n#include <unistd.h>\npid_t __real_getppid(void);pid_t __wrap_getppid(void){static int count=0;return ++count==1?__real_getppid():1;}\n', ['-Wl,--wrap=getppid']]
  ]) {
    const file = path.join(f.root, name + '.c'), executable = path.join(f.root, name); await fs.writeFile(file, wrapper);
    const build = spawnSync('/usr/bin/cc', ['-std=c11','-O2',path.resolve(__dirname,'../native/gridbase-launcher.c'),file,...flags,'-o',executable], { encoding: 'utf8' }); assert.equal(build.status, 0, build.stderr);
    const r = spawnSync(executable, [String(process.pid),java,...javaArgs(f.root)], { env: {}, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 126, name); assert.equal(r.stdout, ''); assert.equal(r.stderr, 'Local engine launch refused.\n');
  }
});