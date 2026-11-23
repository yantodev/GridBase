'use strict';
// Standalone reproducible crossbuild, no root script/manifest activation.
const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
const COMPILER = '/usr/bin/x86_64-w64-mingw32-gcc';
const FLAGS = ['-std=c11','-O2','-Wall','-Wextra','-Werror','-DUNICODE','-D_UNICODE','-D_WIN32_WINNT=0x0A00','-municode','-static-libgcc','-ffile-prefix-map=' + __dirname + '=.','-Wl,--no-insert-timestamp,--dynamicbase,--nxcompat'];
function build(outDir) {
  if (typeof outDir !== 'string' || !path.isAbsolute(outDir)) throw new Error('WINDOWS_BUILD_OUTPUT');
  fs.mkdirSync(outDir,{recursive:true}); const outputs=[];
  for(const [name,sources,libs] of [
    ['gridbase-private-files.exe',['private-files.c','policy.c','inventory.c'],['advapi32','shell32','ole32','uuid','bcrypt']],
    ['gridbase-launch-owned.exe',['launch-owned.c','policy.c'],['advapi32']]
  ]) {
    const output=path.join(outDir,name);
    const result=cp.spawnSync(COMPILER,[...FLAGS,...sources.map(s=>path.join(__dirname,s)),'-o',output,...libs.map(s=>'-l'+s)],{encoding:'utf8'});
    if(result.status!==0)throw new Error('WINDOWS_CROSSBUILD_FAILED\n'+result.stderr);
    const pe=cp.spawnSync('/usr/bin/x86_64-w64-mingw32-objdump',['-p',output],{encoding:'utf8'});
    const imports=[...pe.stdout.matchAll(/DLL Name:\s*(\S+)/g)].map(m=>m[1]);
    const allowed=new Set(['advapi32.dll','bcrypt.dll','kernel32.dll','msvcrt.dll','ole32.dll','shell32.dll']);
    if(pe.status!==0||!pe.stdout.includes('pei-x86-64')||!imports.length||imports.some(s=>!allowed.has(s.toLowerCase())))throw new Error('WINDOWS_PE_IMPORTS');
    outputs.push(output);
  }
  return outputs;
}
if(require.main===module){if(process.argv.length!==3)throw new Error('usage: node build.cjs ABSOLUTE_OUTPUT_DIRECTORY');for(const out of build(process.argv[2]))process.stdout.write(out+'\n');}
module.exports={build,FLAGS};
