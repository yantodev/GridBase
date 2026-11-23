'use strict';
// Native WinAPI job proof fixture, NOT Java/blocked-JDBC acceptance.
const test=require('node:test');const assert=require('node:assert/strict');const cp=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {attachOwned}=require('../windows-launch');
const native={skip:process.platform!=='win32'?'UNVERIFIED: requires native Windows 11 Job Objects':false};
function fixture(){const dir=process.env.GRIDBASE_WINDOWS_FIXTURE_DIR;assert.ok(dir&&path.isAbsolute(dir),'native fixture build directory required');return {dir,launcher:path.join(dir,'gridbase-launch-owned.exe'),child:path.join(dir,'lifetime-fixture.exe'),private:path.join(dir,'native-fixture.exe')};}
function waitClose(child){return new Promise((resolve,reject)=>{child.once('close',code=>resolve(code));child.once('error',reject);});}
async function observe(exe,pid){const child=cp.spawn(exe,['--observe',String(pid)],{stdio:['ignore','pipe','ignore'],windowsHide:true,shell:false});const closed=waitClose(child);await new Promise((resolve,reject)=>{child.stdout.once('data',b=>b.toString().trim()==='OBSERVING'?resolve():reject(Error('observer protocol')));child.once('close',()=>reject(Error('observer failed to capture process HANDLE')));});return {child,closed};}
function roots(f){const base=path.join(os.tmpdir(),'GridBase-lifetime-'+require('node:crypto').randomUUID());for(const target of [base,base+'\\native-owner-protected']){const prep=cp.spawnSync(f.private,[target],{timeout:30000});assert.equal(prep.status,0);}return base;}
test('native Windows launcher death after Owned kills suspended job-covered child, sibling survives',native,async()=>{
 const f=fixture(),base=roots(f),sibling=cp.spawn(path.join(f.dir,'job-fixture.exe'),['--idle'],{cwd:base,stdio:['pipe','pipe','pipe'],shell:false});const siblingClosed=waitClose(sibling);let observer,launcher;
 try{
  launcher=cp.spawn(f.launcher,[],{cwd:base,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});const closed=waitClose(launcher);let phase=0,buffer='';
  const pid=await new Promise((resolve,reject)=>{launcher.stdout.on('data',b=>{buffer+=b.toString();let nl;while((nl=buffer.indexOf('\n'))>=0){const v=JSON.parse(buffer.slice(0,nl));buffer=buffer.slice(nl+1);if(phase++===0){assert.equal(v.event,'HostBound');launcher.stdin.write(JSON.stringify({event:'LaunchOwned',protocol:1,java:f.child,resources:f.dir,classpath:[f.dir],dataDir:base,tempDir:base+'\\native-owner-protected'})+'\n');}else{assert.equal(v.event,'Owned');resolve(v.javaPid);}}});launcher.once('close',()=>reject(Error('launcher closed before Owned')));launcher.stdin.write(JSON.stringify({event:'BindHost',protocol:1,hostPid:process.pid})+'\n');});
  observer=await observe(f.child,pid);launcher.kill();await closed;assert.equal(await observer.closed,0,'captured child HANDLE must become signaled');assert.equal(sibling.exitCode,null);
 }finally{launcher?.kill();observer?.child.kill();sibling.kill();await siblingClosed;fs.rmSync(base,{recursive:true,force:true});}
});
test('native Windows host HANDLE death after ready kills owned child independently of Java input',native,async()=>{
 const f=fixture(),base=roots(f);let owner,observer;
 try{
  const script=`const cp=require('node:child_process');const {attachOwned}=require(${JSON.stringify(require.resolve('../windows-launch'))});(async()=>{const child=cp.spawn(${JSON.stringify(f.launcher)},[],{cwd:${JSON.stringify(base)},stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});const owned=await attachOwned(child,${JSON.stringify({event:'LaunchOwned',protocol:1,java:f.child,resources:f.dir,classpath:[f.dir],dataDir:base,tempDir:base+'\\native-owner-protected'})},'1.4.0');owned.stdout.once('data',()=>process.send({pid:owned.expectedJavaPid}));owned.stdin.write(JSON.stringify({protocol:1,capability:'A'.repeat(43),credentialKey:'A'.repeat(43),clientKind:'desktop'})+'\\n');})().catch(()=>process.exit(7));`;
  owner=cp.spawn(process.execPath,['-e',script],{stdio:['ignore','ignore','ignore','ipc'],shell:false,windowsHide:true});const closed=waitClose(owner);
  const pid=await new Promise((resolve,reject)=>{owner.once('message',v=>resolve(v.pid));owner.once('close',()=>reject(Error('fixture host closed before ready')));});observer=await observe(f.child,pid);owner.kill();await closed;assert.equal(await observer.closed,0,'captured child HANDLE must signal after actual host death');
 }finally{owner?.kill();observer?.child.kill();fs.rmSync(base,{recursive:true,force:true});}
});
test('native Windows EOF grace terminates actual retained child handle and records observed forced exit',native,async()=>{
 const f=fixture(),base=roots(f);const temp=base+'\\native-owner-protected';let child;
 try{child=cp.spawn(f.launcher,[],{cwd:base,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});const owned=await attachOwned(child,{event:'LaunchOwned',protocol:1,java:f.child,resources:f.dir,classpath:[f.dir],dataDir:base,tempDir:temp},'1.4.0');
  const ready=new Promise(resolve=>owned.stdout.once('data',resolve));owned.stdin.write(JSON.stringify({protocol:1,capability:'A'.repeat(43),credentialKey:'A'.repeat(43),clientKind:'desktop'})+'\n');await ready;
  const observer=await observe(f.child,owned.expectedJavaPid);try{const result=await owned.stop();assert.equal(await observer.closed,0);assert.equal(result.java.observed,true);assert.equal(result.java.forced,true);}finally{observer.child.kill();}
 }finally{child?.kill();fs.rmSync(base,{recursive:true,force:true});}
});
