'use strict';
// I2 real native scenarios. On Windows missing prerequisites FAIL explicitly;
// Linux skips native semantics, not missing source. No account/ACL setup here.
const test=require('node:test');const assert=require('node:assert/strict');const cp=require('node:child_process');const crypto=require('node:crypto');const os=require('node:os');
const x=require('./windows-fixture-tools.cjs');
const native={skip:process.platform!=='win32'?'UNVERIFIED: requires disposable Windows11 NTFS profile and explicit synthetic-principal/reparse prerequisites':false};
function run(name,args,marker){const f=x.files();const result=cp.spawnSync(x.path.join(f.dir,name+'.exe'),args,{encoding:'utf8',timeout:60000});assert.equal(result.status,0,'native fixture/prerequisite failure '+name+': '+result.stderr);assert.equal(result.stdout.trim(),marker);}
test('native two ordinary TokenUsers: first-observable denial, preexisting opens and 12 exact broad-parent variants',native,()=>{
 const pid=process.env.GRIDBASE_WINDOWS_OTHER_USER_PID;assert.match(pid||'',/^[1-9][0-9]*$/,'requires preprovisioned other ordinary-user process/token with explicit QUERY,DUPLICATE,IMPERSONATE permission; no credentials');
 const root=x.path.join(os.tmpdir(),'GridBase-two-user-'+crypto.randomUUID());try{run('security-fixture',[root,pid],'NATIVE_SECURITY_MATRIX_OK');}finally{x.fs.rmSync(root,{recursive:true,force:true});}
});
test('native symlink/junction leaf+ancestor, case alias, pending-delete and replaced retained identity',native,()=>{
 const root=x.path.join(os.tmpdir(),'GridBase-identity-'+crypto.randomUUID());try{run('identity-fixture',[root],'NATIVE_IDENTITY_MATRIX_OK');}finally{x.fs.rmSync(root,{recursive:true,force:true});}
});
test('native preprovisioned volume mount and non-symlink/non-junction reparse unchanged rejection',native,()=>{
 const root=process.env.GRIDBASE_WINDOWS_REPARSE_ROOT,mount=process.env.GRIDBASE_WINDOWS_MOUNT_POINT,other=process.env.GRIDBASE_WINDOWS_OTHER_REPARSE;
 for(const p of [root,mount,other])assert.ok(p&&x.path.isAbsolute(p),'requires fixture-owned preprovisioned private root with mounted-volume and other-tag reparse children; never creates mount or changes host policy');
 run('identity-fixture',[root,mount,other],'NATIVE_IDENTITY_MATRIX_OK');
 // Preprovisioned resources intentionally remain untouched, including on failure.
});
test('native actual fixed KnownFolder default paths and trusted-ancestor versus owner-only root',native,()=>{
 assert.equal(process.env.GRIDBASE_WINDOWS_DISPOSABLE_PROFILE,'1','requires preprovisioned disposable current profile: actual fixed LocalAppData path is exercised');
 const trusted=process.env.GRIDBASE_WINDOWS_TRUSTED_ANCESTOR;assert.ok(trusted&&x.path.isAbsolute(trusted),'requires read-only fixture-owned SYSTEM/Admin/TrustedInstaller-owned directory');
 run('knownfolder-fixture',[trusted],'NATIVE_KNOWNFOLDER_MATRIX_OK');
});
