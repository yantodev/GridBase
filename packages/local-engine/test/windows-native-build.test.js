'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const cp = require('node:child_process');
test('portable native C codec consumes shared Node vectors and rejects overflow/UTF8', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-codec-'));
  try {
    const source = path.resolve(__dirname, '../native/windows/codec-test.c'); const exe = path.join(dir, 'codec');
    const compile = cp.spawnSync('/usr/bin/cc', ['-std=c11','-O2','-Wall','-Wextra','-Werror',source,'-o',exe], { encoding:'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const frame = require('../windows-protocol').encodeRequest(3,1,{root:0x12345678});
    const run = cp.spawnSync(exe, [], { input: frame }); assert.equal(run.status, 0); assert.deepEqual(run.stdout, frame);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});
test('portable native launch parser rejects duplicate/escaped/unknown fields and malformed scalars', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'windows-json-'));
 try{const exe=path.join(dir,'parser');const c=cp.spawnSync('/usr/bin/cc',['-std=c11','-O2','-Wall','-Wextra','-Werror',path.resolve(__dirname,'../native/windows/launch-json-test.c'),'-o',exe],{encoding:'utf8'});assert.equal(c.status,0,c.stderr);const r=cp.spawnSync(exe,[],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('fixture scheduling validates exact insertion sites without touching production source', () => {
 const {instrumentLaunch,SITES}=require('../native/windows/fixture-build.cjs');const source=fs.readFileSync(path.resolve(__dirname,'../native/windows/launch-owned.c'),'utf8');const result=instrumentLaunch(source);assert.equal(result.match(/fx_launch_barrier\(/g).length,SITES.length);assert.equal(source.includes('fx_launch_barrier'),false);assert.throws(()=>instrumentLaunch(source.replace(SITES[2][1],'')),/FIXTURE_INSERTION_SITE_before-create/);assert.throws(()=>instrumentLaunch(source+SITES[0][1]),/FIXTURE_INSERTION_SITE_before-bind/);
});
test('both native helpers crosscompile as AMD64 with only OS DLL imports', () => {
  const { build } = require('../native/windows/build.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-pe-'));
  try {
    const outputs = build(dir); assert.equal(outputs.length, 2);
    const fixtures=require('../native/windows/fixture-build.cjs').buildFixtures(dir);assert.equal(fixtures.length,9);outputs.push(...fixtures);
    for (const output of outputs) { const result = cp.spawnSync('/usr/bin/x86_64-w64-mingw32-objdump',['-p',output],{encoding:'utf8'}); assert.equal(result.status,0); assert.match(result.stdout,/pei-x86-64/); assert.doesNotMatch(result.stdout,/DLL Name:.*(?:libgcc|libwinpthread|libstdc)/i); }
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
