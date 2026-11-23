'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { LaunchPhases } = require('../windows-launch');
const { spawn } = require('node:child_process');
test('real launcher transport fixture preserves split ready bytes and uncertain wrapper exit', async t => {
 const fixture = `let s=0;const readline=require('node:readline').createInterface({input:process.stdin});readline.on('line',line=>{const v=JSON.parse(line);if(s++===0)process.stdout.write(JSON.stringify({event:'HostBound',protocol:1,hostPid:v.hostPid})+'\\n');else if(s===2)process.stdout.write('{"event":"Owned","protocol":1,"javaPid":123}\\n');else if(s===4){const b=Buffer.from('{"event":"ready","protocol":1,"pid":123,"port":1234,"version":"1.4.0"}\\n');process.stdout.write(b.subarray(0,9));setTimeout(()=>process.stdout.write(b.subarray(9)),5);}});readline.on('close',()=>process.exit(0));`;
 const child=spawn(process.execPath,['-e',fixture],{stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());
 const owned=await require('../windows-launch').attachOwned(child,{event:'LaunchOwned'},'1.4.0',{timeout:1000});
 const chunks=[]; owned.stdout.on('data',b=>chunks.push(b));
 const ready=new Promise(resolve=>owned.stdout.on('data',()=>{if(Buffer.concat(chunks).includes(10))resolve();}));
 owned.stdin.write(JSON.stringify({protocol:1,capability:'A'.repeat(43),credentialKey:'A'.repeat(43),clientKind:'desktop'})+'\n');
 await ready;
 assert.doesNotThrow(()=>JSON.parse(Buffer.concat(chunks).toString()));
 assert.equal((await owned.stop()).uncertain,true);
});
test('launch transport startup timeout/EOF/malformed metadata kills and awaits only owned wrapper', async t => {
 for(const mode of ['hang','eof','bad']){
  const child=spawn(process.execPath,['-e',mode==='hang'?'setInterval(()=>{},1000)':mode==='eof'?'process.exit(0)':'process.stdout.write("invalid-secret\\n");setInterval(()=>{},1000)'],{stdio:['pipe','pipe','pipe']});t.after(()=>child.kill());
  await assert.rejects(require('../windows-launch').attachOwned(child,{event:'LaunchOwned'},'1.4.0',{timeout:100}), e=>e.code==='WINDOWS_START_FAILED'&&!JSON.stringify(e).includes('invalid-secret'));
  assert.ok(child.exitCode!==null||child.signalCode!==null);
 }
});
test('configuration rejects manifest path injection and private-root overlap', () => {
 const {configuration}=require('../windows-launch');
 const options={verifiedBundle:{bundleDir:'C:\\installed',version:'1.4.0',java:'C:\\installed\\jre\\bin\\java.exe',resources:'C:\\installed\\resources',classpath:['C:\\installed\\classes']},dataDir:'C:\\private',tempDir:'C:\\temp'};
 assert.equal(configuration(options).event,'LaunchOwned');
 assert.throws(()=>configuration({...options,tempDir:'C:\\PRIVATE'}));
 assert.throws(()=>configuration({...options,verifiedBundle:{...options.verifiedBundle,java:'C:\\outside\\java.exe'}}));
});
test('launch exact phases split/coalesced output preserves real Java PID, never wrapper PID', () => {
 const p = new LaunchPhases(42,'1.4.0');
 assert.deepEqual(p.push(Buffer.from('{"event":"Host')), []);
 assert.deepEqual(p.push(Buffer.from('Bound","protocol":1,"hostPid":42}\n')), [{event:'HostBound',protocol:1,hostPid:42}]);
 p.sentLaunch();
 assert.equal(p.push(Buffer.from('{"event":"Owned","protocol":1,"javaPid":123}\n'))[0].javaPid,123);
 p.sentCommit(); p.sentBootstrap();
 assert.equal(p.push(Buffer.from('{"event":"ready","protocol":1,"pid":123,"port":1234,"version":"1.4.0"}\n'))[0].pid,123);
 assert.throws(()=>p.push(Buffer.from('x')));
});
test('launch rejects duplicates/wrong phase/PID/secret reflection/oversize/terminal ambiguity', () => {
 for(const line of ['{"event":"Owned","protocol":1,"javaPid":2}\n','{"event":"HostBound","event":"HostBound","protocol":1,"hostPid":42}\n','{"event":"HostBound","protocol":1,"hostPid":43}\n']) assert.throws(()=>new LaunchPhases(42,'1.4.0').push(Buffer.from(line)));
 assert.throws(()=>new LaunchPhases(42,'1.4.0').push(Buffer.alloc(257,65)));
 const { terminalProof }=require('../windows-launch');
 assert.deepEqual(terminalProof(Buffer.alloc(0),123),{observed:false,code:null,forced:null});
 assert.equal(terminalProof(Buffer.from('{"event":"JavaExited","protocol":1,"javaPid":123,"code":0,"forced":false}\n'),123).observed,true);
 assert.equal(terminalProof(Buffer.from('{"event":"JavaExited","protocol":1,"javaPid":999,"code":0,"forced":false}\n'),123).observed,false);
});
