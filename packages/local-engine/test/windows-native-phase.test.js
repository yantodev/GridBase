'use strict';
// I3: true WinAPI pipes/process/jobs only; no Linux mocks or native claims.
const test=require('node:test');const assert=require('node:assert/strict');const cp=require('node:child_process');
const {attachOwned}=require('../windows-launch');const x=require('./windows-fixture-tools.cjs');
const native={skip:process.platform!=='win32'?'UNVERIFIED: requires disposable native Windows11 Job Objects/NTFS fixture assets':false};
for(const mode of ['invalid-bind','duplicate-bind','before-bind-eof','no-bind-timeout','no-live-ack','no-ack-timeout','launch-before-bind','prequeued-ack','invalid-launch'])test('native strict bind/live-ack phase refuses '+mode,native,async()=>{
 const f=x.files(),base=x.root(f),child=x.spawn(f.launcher,[],{cwd:base}),next=x.lines(child.stdout);
 try{
  if(mode==='invalid-bind')child.stdin.end('{"event":"BindHost","protocol":2,"hostPid":1}\n');
  else if(mode==='duplicate-bind')child.stdin.end('{"event":"BindHost","protocol":1,"hostPid":1,"hostPid":2}\n');
  else if(mode==='before-bind-eof')child.stdin.end();
  else if(mode==='no-bind-timeout'){/* production 30s total deadline */}
  else if(mode==='launch-before-bind')x.send(child,x.config(f,base));
  else if(mode==='prequeued-ack')child.stdin.end(JSON.stringify({event:'BindHost',protocol:1,hostPid:process.pid})+'\n'+JSON.stringify(x.config(f,base))+'\n');
  else {await x.bind(child,next);if(mode==='invalid-launch')x.send(child,{...x.config(f,base),extra:'not-allowed'});else if(mode!=='no-ack-timeout')child.stdin.end();}
  const result=await child.closed;assert.equal(result.code,7);assert.equal(x.fs.existsSync(x.path.join(base,'fixture-started')),false);
 }finally{await x.dispose(child);x.fs.rmSync(base,{recursive:true,force:true});}
});
for(const mode of ['bad-commit','duplicate-commit','eof-before-commit','no-commit-timeout','bootstrap-before-commit'])test('native suspended child exact termination on '+mode,native,async()=>{
 const f=x.files(),base=x.root(f),child=x.spawn(f.launcher,[],{cwd:base}),next=x.lines(child.stdout);let observe;
 try{
  const pid=await x.owned(child,next,x.config(f,base));observe=await x.observer(f,pid);
  if(mode==='bad-commit')x.send(child,{event:'Commit',protocol:2});else if(mode==='duplicate-commit')child.stdin.write('{"event":"Commit","protocol":1,"protocol":1}\n');else if(mode==='bootstrap-before-commit')x.send(child,x.bootstrap());else if(mode!=='no-commit-timeout')child.stdin.end();
  assert.equal((await child.closed).code,7);assert.equal((await observe.closed).code,0);assert.equal(x.fs.existsSync(x.path.join(base,'fixture-started')),false);
 }finally{await x.dispose(child);await x.dispose(observe);x.fs.rmSync(base,{recursive:true,force:true});}
});
for(const phase of ['before-bind','bound','owned'])test('native actual host death before commit at '+phase,native,async()=>{
 const f=x.files(),base=x.root(f);let owner,observe,launcherObserve;
 try{
  const script=`const cp=require('node:child_process');const readline=require('node:readline');const child=cp.spawn(${JSON.stringify(f.launcher)},[],{cwd:${JSON.stringify(base)},stdio:['pipe','pipe','pipe'],shell:false});child.stderr.resume();child.stdin.on('error',()=>{});let stage=0;readline.createInterface({input:child.stdout}).on('line',s=>{const v=JSON.parse(s);if(v.event==='HostBound'){if(${JSON.stringify(phase)}==='bound')process.send({launcher:child.pid});else child.stdin.write(JSON.stringify(${JSON.stringify(x.config(f,base))})+'\\n');}else if(v.event==='Owned')process.send({launcher:child.pid,pid:v.javaPid});});if(${JSON.stringify(phase)}==='before-bind')process.send({launcher:child.pid});else child.stdin.write(JSON.stringify({event:'BindHost',protocol:1,hostPid:process.pid})+'\\n');setInterval(()=>{},1000);`;
  owner=x.spawn(process.execPath,['-e',script],{stdio:['ignore','ignore','ignore','ipc']});
  const metadata=await new Promise((resolve,reject)=>{owner.once('message',resolve);owner.once('close',()=>reject(Error('host fixture exited before phase')));});launcherObserve=await x.observer(f,metadata.launcher);if(metadata.pid)observe=await x.observer(f,metadata.pid);
  owner.kill('SIGKILL');await owner.closed;assert.equal((await launcherObserve.closed).code,0);if(observe)assert.equal((await observe.closed).code,0);assert.equal(x.fs.existsSync(x.path.join(base,'fixture-started')),false);
 }finally{await x.dispose(owner);await x.dispose(observe);await x.dispose(launcherObserve);x.fs.rmSync(base,{recursive:true,force:true});}
});
for(const stage of ['before-bind','after-bind','before-create','after-create','before-resume','after-resume'])for(const death of ['launcher','host'])test('native fixture-copy race '+stage+' '+death+' death',native,async()=>{
 const f=x.files(),base=x.root(f),barrier=await x.barrier(f,stage);let child,observe,launcherObserve;
 try{
  // Host child owns the launcher; it sends phase PID over private IPC, never a
  // global query. The instrumented helper differs only by validated barriers.
  const script=`const cp=require('node:child_process');const rl=require('node:readline');const child=cp.spawn(${JSON.stringify(f.instrumented)},[],{cwd:${JSON.stringify(base)},env:${JSON.stringify(barrier.env)},stdio:['pipe','pipe','pipe'],shell:false});process.send({launcher:child.pid});child.stdin.on('error',()=>{});child.stderr.resume();rl.createInterface({input:child.stdout}).on('line',s=>{const v=JSON.parse(s);if(v.event==='HostBound')child.stdin.write(JSON.stringify(${JSON.stringify(x.config(f,base))})+'\\n');else if(v.event==='Owned')child.stdin.write('{"event":"Commit","protocol":1}\\n');});child.stdin.write(JSON.stringify({event:'BindHost',protocol:1,hostPid:process.pid})+'\\n');process.on('message',m=>{if(m==='kill')child.kill('SIGKILL');});setInterval(()=>{},1000);`;
  child=x.spawn(process.execPath,['-e',script],{stdio:['ignore','ignore','ignore','ipc']});const info=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('close',()=>reject(Error('race owner exit')));});
  const point=JSON.parse(await barrier.next());if(['after-create','before-resume','after-resume'].includes(stage))assert.ok(point.pid>0,'boundary must contain an actual created process');else assert.equal(point.pid,0);launcherObserve=await x.observer(f,info.launcher);if(point.pid)observe=await x.observer(f,point.pid);
  if(death==='host'){child.kill('SIGKILL');await child.closed;}else {child.send('kill');assert.equal((await launcherObserve.closed).code,0);}
  // Release after the death action to exercise the production post-call live
  // host recheck as well as the already-established job association.
  barrier.child.stdin.write('R');assert.equal((await launcherObserve.closed).code,0);if(observe)assert.equal((await observe.closed).code,0);
  if(['before-bind','after-bind','before-create','after-create','before-resume'].includes(stage))assert.equal(x.fs.existsSync(x.path.join(base,'fixture-started')),false);
 }finally{await x.dispose(child);await x.dispose(observe);await x.dispose(launcherObserve);await x.dispose(barrier.child);x.fs.rmSync(base,{recursive:true,force:true});}
});
test('native exact Java HANDLE_LIST excludes real job,host,control object handles',native,async()=>{
 const f=x.files(),base=x.root(f),barrier=await x.barrier(f,'before-resume'),child=x.spawn(f.instrumented,[],{cwd:base,env:barrier.env}),next=x.lines(child.stdout);let observe;
 try{
  const pid=await x.owned(child,next,x.config(f,base));x.send(child,{event:'Commit',protocol:1});const point=JSON.parse(await barrier.next());assert.equal(point.pid,pid);observe=await x.observer(f,pid);
  const inspection=cp.spawnSync(f.job,['--inspect',String(child.pid),String(point.job),String(point.host),String(point.control),String(point.output),String(point.error),String(pid)],{encoding:'utf8',timeout:20000});assert.equal(inspection.status,0,inspection.stderr);assert.equal(inspection.stdout.trim(),'NATIVE_HANDLE_EXCLUSION_OK');
  child.kill('SIGKILL');barrier.child.stdin.write('R');assert.equal((await observe.closed).code,0);
 }finally{await x.dispose(child);await x.dispose(observe);await x.dispose(barrier.child);x.fs.rmSync(base,{recursive:true,force:true});}
});
for(const incompatible of [false,true])test('native fixture-owned enclosing job '+(incompatible?'refuses nested UI policy':'keeps unrelated sibling alive'),native,async()=>{
 const f=x.files(),base=x.root(f),report=x.path.join(base,'outer-result.json'),child=x.spawn(f.job,['--outer',f.launcher,report,...(incompatible?['ui']:[])],{cwd:base}),next=x.lines(child.stdout);let observe;
 try{
  if(incompatible){assert.equal((await child.closed).code,0);const result=JSON.parse(x.fs.readFileSync(report));assert.equal(result.launcherCode,5);assert.equal(result.siblingSurvived,true);assert.equal(x.fs.existsSync(x.path.join(base,'fixture-started')),false);}
  else{const pid=await x.owned(child,next,x.config(f,base));observe=await x.observer(f,pid);child.stdin.end('{"event":"Commit","protocol":2}\n');assert.equal((await child.closed).code,0);assert.equal((await observe.closed).code,0);const result=JSON.parse(x.fs.readFileSync(report));assert.equal(result.launcherCode,7);assert.equal(result.siblingSurvived,true);assert.equal(result.activeProcesses,1);}
 }finally{await x.dispose(child);await x.dispose(observe);x.fs.rmSync(base,{recursive:true,force:true});}
});
for(const mode of ['wrong-pid','reflect','oversize','extra','split'])test('native readiness output '+mode+' through real launcher pipes',native,async()=>{
 const f=x.files(),base=x.root(f);x.fs.writeFileSync(x.path.join(base,'fixture-mode'),mode);const child=x.spawn(f.launcher,[],{cwd:base});let observe;
 try{
  const owned=await attachOwned(child,x.config(f,base),'1.4.0');observe=await x.observer(f,owned.expectedJavaPid);let output=Buffer.alloc(0);owned.stdout.on('data',b=>{output=Buffer.concat([output,b]);});const ready=new Promise(resolve=>owned.stdout.once('data',resolve));owned.stdin.write(JSON.stringify(x.bootstrap())+'\n');
  if(mode==='split'){await ready;assert.equal(JSON.parse(output).pid,owned.expectedJavaPid);await owned.stop();}
  const result=await owned.closed;assert.equal((await observe.closed).code,0);if(mode!=='split'){assert.equal(result.uncertain,true);assert.ok(!output.toString().includes(x.bootstrap().credentialKey));if(mode!=='extra')assert.equal(output.length,0);}
 }finally{await x.dispose(child);await x.dispose(observe);x.fs.rmSync(base,{recursive:true,force:true});}
});
