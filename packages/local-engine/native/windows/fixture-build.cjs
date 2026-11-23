'use strict';
// Test-only native builds. Scheduling edits are made ONLY in an owned output
// copy. Each unique insertion site is validated; production source untouched.
const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');
const {FLAGS}=require('./build.cjs');
const SITES=Object.freeze([
 ['before-bind','state.host=OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,host_pid);','0'],
 ['after-bind','HANDLE watchdog=CreateThread(NULL,0,host_watchdog,NULL,0,NULL);','0'],
 ['before-create','ok=CreateProcessW(c->java,cmd,NULL,NULL,TRUE,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,env,c->data,&si.StartupInfo,pi);','0'],
 ['after-create','done:if(child_in)CloseHandle(child_in);','pi->dwProcessId'],
 ['before-resume','InterlockedExchange(&state.input_phase,3);SetEvent(state.input_consumed);if(!host_alive()||ResumeThread(pi.hThread)==(DWORD)-1)fatal();','pi.dwProcessId'],
 ['after-resume','HANDLE output_thread=CreateThread(NULL,0,ready_reader,NULL,0,NULL),error_thread=CreateThread(NULL,0,discard_error,NULL,0,NULL);','pi.dwProcessId']
]);
function instrumentLaunch(source){
 let result='#include "launch-barrier-fixture.h"\n'+source;
 for(const [stage,site,pid] of SITES){if(result.split(site).length!==2)throw Error('FIXTURE_INSERTION_SITE_'+stage);result=result.replace(site,`fx_launch_barrier(L"${stage}",${pid},state.job,state.host);\n ${site}`);}
 return result;
}
function buildFixtures(out){
 if(typeof out!=='string'||!path.isAbsolute(out))throw Error('FIXTURE_OUTPUT');fs.mkdirSync(out,{recursive:true});
 const copy=path.join(out,'instrumented');fs.mkdirSync(copy,{recursive:true});
 const original=fs.readFileSync(path.join(__dirname,'launch-owned.c'),'utf8');
 const transformed=instrumentLaunch(original);fs.writeFileSync(path.join(copy,'launch-owned.c'),transformed);
 const configurations=[
  ['codec-test',['codec-test.c'],[],'console'],
  ['launch-json-test',['launch-json-test.c'],[],'console'],
  ['native-fixture',['native-fixture.c','policy.c'],['advapi32']],
  ['lifetime-fixture',['lifetime-fixture.c'],[]],
  ['security-fixture',['security-fixture.c','policy.c'],['advapi32']],
  ['identity-fixture',['identity-fixture.c','policy.c'],['advapi32']],
  ['knownfolder-fixture',['knownfolder-fixture.c','policy.c','inventory.c'],['advapi32','shell32','ole32','uuid','bcrypt']],
  ['job-fixture',['job-fixture.c'],[]],
  ['gridbase-launch-owned-instrumented',[path.join(copy,'launch-owned.c'),'policy.c'],['advapi32']]
 ];const results=[];
 for(const [name,sources,libs,entry]of configurations){const exe=path.join(out,name+'.exe');const flags=entry==='console'?FLAGS.filter(f=>f!=='-municode'):FLAGS;const r=cp.spawnSync('/usr/bin/x86_64-w64-mingw32-gcc',[...flags,'-I',__dirname,...sources.map(s=>path.isAbsolute(s)?s:path.join(__dirname,s)),'-o',exe,...libs.map(l=>'-l'+l)],{encoding:'utf8'});if(r.status!==0)throw Error('FIXTURE_BUILD_'+name+'\n'+r.stderr);
 const pe=cp.spawnSync('/usr/bin/x86_64-w64-mingw32-objdump',['-p',exe],{encoding:'utf8'});if(pe.status!==0||!pe.stdout.includes('pei-x86-64')||/DLL Name:.*(?:libgcc|libwinpthread|libstdc)/i.test(pe.stdout))throw Error('FIXTURE_PE_'+name);results.push(exe);}
 return results;
}
if(require.main===module){for(const file of buildFixtures(process.argv[2]))console.log(file);}
module.exports={buildFixtures,instrumentLaunch,SITES};
