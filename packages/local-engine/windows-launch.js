'use strict';
// Host-internal candidate only; EngineClient's existing Windows gate is unchanged.
const { spawn } = require('node:child_process'); const { PassThrough } = require('node:stream'); const path = require('node:path');
const { strictJson } = require('./protocol'); const { fail, exact, uint, absolutePath } = require('./windows-protocol');
function line(value, max) { const b = Buffer.from(JSON.stringify(value) + '\n'); if (b.length > max) throw fail(); return b; }
class LaunchPhases {
  constructor(hostPid, version) { uint(hostPid, true); this.hostPid = hostPid; this.version = version; this.phase = 'bound'; this.buffer = Buffer.alloc(0); this.pid = null; }
  push(chunk) {
    if (!Buffer.isBuffer(chunk) || this.phase === 'ready') throw fail();
    const max = this.phase === 'readyLine' ? 8192 : 256;
    if (this.buffer.length + chunk.length > max) throw fail(); this.buffer = Buffer.concat([this.buffer, chunk]);
    const nl = this.buffer.indexOf(10); if (nl < 0) return [];
    // A helper must wait for the host reply between metadata phases; coalesced
    // future-phase output is not legitimate. Chunk splits are arbitrary.
    if (nl !== this.buffer.length - 1) throw fail();
    let v; try { v = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, nl)), max); } catch { throw fail(); }
    this.buffer.fill(0); this.buffer = Buffer.alloc(0);
    if (this.phase === 'bound') { exact(v,['event','protocol','hostPid']); if (v.event !== 'HostBound' || v.protocol !== 1 || v.hostPid !== this.hostPid) throw fail(); this.phase = 'launch'; }
    else if (this.phase === 'owned') { exact(v,['event','protocol','javaPid']); uint(v.javaPid,true); if (v.event !== 'Owned' || v.protocol !== 1) throw fail(); this.pid = v.javaPid; this.phase = 'commit'; }
    else if (this.phase === 'readyLine') { exact(v,['event','protocol','pid','port','version']); if (v.event !== 'ready' || v.protocol !== 1 || v.pid !== this.pid || v.version !== this.version || !Number.isInteger(v.port) || v.port < 1 || v.port > 65535) throw fail(); this.phase = 'ready'; }
    else throw fail(); return [v];
  }
  sentLaunch() { if (this.phase !== 'launch') throw fail(); this.phase = 'owned'; }
  sentCommit() { if (this.phase !== 'commit') throw fail(); this.phase = 'bootstrap'; }
  sentBootstrap() { if (this.phase !== 'bootstrap') throw fail(); this.phase = 'readyLine'; }
}
function terminalProof(bytes, expected) {
  const uncertain = { observed: false, code: null, forced: null };
  try { if (bytes.length > 256 || bytes.at(-1) !== 10 || bytes.subarray(0,-1).includes(10)) return uncertain;
    const v = strictJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes),256); exact(v,['event','protocol','javaPid','code','forced']); uint(v.code);
    if(v.event !== 'JavaExited' || v.protocol !== 1 || v.javaPid !== expected || typeof v.forced !== 'boolean') return uncertain;
    return Object.freeze({ observed:true, code:v.code, forced:v.forced });
  } catch { return uncertain; }
}
function configuration(options) {
  exact(options,['verifiedBundle','dataDir','tempDir']);
  const {verifiedBundle,dataDir,tempDir}=options;
  exact(verifiedBundle,['bundleDir','version','java','resources','classpath']);
  if(typeof verifiedBundle.version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(verifiedBundle.version))throw fail();
  for(const p of [verifiedBundle.bundleDir,verifiedBundle.java,verifiedBundle.resources,dataDir,tempDir]) absolutePath(p);
  const lower = p => p.toLowerCase();
  const inside = p => lower(p).startsWith(lower(verifiedBundle.bundleDir) + '\\');
  if (!inside(verifiedBundle.java) || !inside(verifiedBundle.resources) || !Array.isArray(verifiedBundle.classpath) || !verifiedBundle.classpath.length || verifiedBundle.classpath.length > 1024) throw fail();
  for(const p of verifiedBundle.classpath) { absolutePath(p); if(!inside(p) || p.includes(';')) throw fail(); }
  for (const a of [verifiedBundle.bundleDir,dataDir,tempDir]) for (const b of [verifiedBundle.bundleDir,dataDir,tempDir]) if(a!==b && lower(a).startsWith(lower(b)+'\\')) throw fail();
  if(new Set([verifiedBundle.bundleDir,dataDir,tempDir].map(lower)).size!==3)throw fail();
  return { event:'LaunchOwned',protocol:1,java:verifiedBundle.java,resources:verifiedBundle.resources,classpath:verifiedBundle.classpath,dataDir,tempDir };
}
async function launchOwned(options) {
  if(process.platform!=='win32')throw fail('WINDOWS_UNSUPPORTED');
  const config=configuration(options), bundle=options.verifiedBundle;
  const env={TEMP:options.tempDir,TMP:options.tempDir}; for(const k of ['SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[k])env[k]=process.env[k];
  const child=spawn(path.win32.join(bundle.bundleDir,'engine','native','win32-x64','gridbase-launch-owned.exe'),[],{shell:false,windowsHide:true,cwd:options.dataDir,env,stdio:['pipe','pipe','pipe']});
  return attachOwned(child,config,bundle.version);
}
// Separate transport seam for actual executable fixtures; not production path DI.
async function attachOwned(child,config,version,{timeout=30000}={}) {
  const phases=new LaunchPhases(process.pid,version), stdout=new PassThrough(), stdin=new PassThrough(); let terminal=Buffer.alloc(0), failed=false, bootstrap=false, resolved=false, rejectStart, resolveStart;
  const start=new Promise((resolve,reject)=>{resolveStart=resolve;rejectStart=reject;}); let readyBytes=Buffer.alloc(0);
  const kill=()=>{ if(failed)return; failed=true; readyBytes.fill(0); rejectStart(fail('WINDOWS_ENGINE_EXITED')); child.stdin.destroy(); child.kill(); stdout.destroy(); };
  const timer=setTimeout(kill,timeout);
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>{clearTimeout(timer);const proof=terminalProof(terminal,phases.pid);terminal.fill(0);if(!resolved)rejectStart(fail('WINDOWS_ENGINE_EXITED'));stdout.end();resolve(Object.freeze({java:proof,wrapper:{code:Number.isInteger(code)?code:null,signal:signal||null},uncertain:!proof.observed}));}));
  child.stderr.on('data',b=>{if(terminal.length+b.length<=256)terminal=Buffer.concat([terminal,b]);else {terminal.fill(0);terminal=Buffer.alloc(257);}});
  child.on('error',kill);child.stdin.on('error',kill);stdout.on('error',()=>{});stdin.on('error',kill);
  child.stdout.on('data',b=>{try{if(phases.phase==='readyLine'){if(readyBytes.length+b.length>8192)throw fail();readyBytes=Buffer.concat([readyBytes,b]);}for(const event of phases.push(b)){
    if(event.event==='HostBound'){phases.sentLaunch();child.stdin.write(line(config,65536));}
    else if(event.event==='Owned'){
      phases.sentCommit();child.stdin.write(line({event:'Commit',protocol:1},256));resolved=true;
      resolveStart(Object.freeze({expectedJavaPid:phases.pid,stdin,stdout,closed,stop}));
    }else if(event.event==='ready'){clearTimeout(timer);stdout.write(readyBytes);readyBytes=Buffer.alloc(0);}
  }}catch{kill();}});
  let buffer=Buffer.alloc(0);
  stdin.on('data',b=>{if(bootstrap){kill();return;}if(buffer.length+b.length>8192){kill();return;}buffer=Buffer.concat([buffer,b]);if(!buffer.includes(10))return;
    try{if(buffer.indexOf(10)!==buffer.length-1)throw fail();const v=strictJson(new TextDecoder('utf-8',{fatal:true}).decode(buffer),8192);exact(v,['protocol','capability','credentialKey','clientKind']);if(v.protocol!==1||!['desktop','vscode'].includes(v.clientKind)||![v.capability,v.credentialKey].every(x=>typeof x==='string'&&/^[A-Za-z0-9_-]{43}$/.test(x)&&Buffer.from(x,'base64url').toString('base64url')===x))throw fail();phases.sentBootstrap();bootstrap=true;child.stdin.write(buffer,()=>buffer.fill(0));}catch{buffer.fill(0);kill();}
  });
  stdin.on('end',()=>{if(!bootstrap)kill();else child.stdin.end();});
  function stop(){stdin.end();return closed;}
  child.stdin.write(line({event:'BindHost',protocol:1,hostPid:process.pid},256));
  try{return await start;}catch{kill();await closed;throw fail('WINDOWS_START_FAILED');}
}
module.exports={LaunchPhases,terminalProof,configuration,launchOwned,attachOwned};
