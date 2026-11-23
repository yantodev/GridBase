'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');
const {spawnSync}=require('node:child_process');
const pack = require('../scripts/package-engine');
require('./package-engine-safety.test');
async function archive(t,kind,entries) {
 const dir=await area(t),file=path.join(dir,'fixture.'+(kind==='zip'?'zip':'tar'));
 const script=`import io,json,sys,tarfile,zipfile,stat\ne=json.loads(sys.argv[3])\nif sys.argv[2]=='zip':\n with zipfile.ZipFile(sys.argv[1],'w') as z:\n  for x in e:\n   i=zipfile.ZipInfo(x['name']);i.create_system=3;i.external_attr=((stat.S_IFDIR if x['name'].endswith('/') else stat.S_IFLNK if x.get('type')=='link' else stat.S_IFREG)|x.get('mode',0o644))<<16;z.writestr(i,x.get('data','bytes'))\nelse:\n with tarfile.open(sys.argv[1],'w') as z:\n  for x in e:\n   i=tarfile.TarInfo(x['name']);b=x.get('data','bytes').encode();i.size=len(b)\n   if x.get('type') in ['link','hard','fifo']:\n    i.type={'link':tarfile.SYMTYPE,'hard':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE}[x['type']];i.linkname=x.get('to','');i.size=0;z.addfile(i)\n   else:z.addfile(i,io.BytesIO(b))`;
 const r=spawnSync('python3',['-c',script,file,kind,JSON.stringify(entries)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return {file,out:path.join(dir,'extracted')};
}
test('bounded extractor rejects portable-path escapes, aliases, special types and unapproved links',async t=>{
 for(const kind of ['tar','zip'])for(const name of ['../escape','/absolute','C:/drive','root/../escape','root\\\\escape','root/NUL','root/a.']) {
  const f=await archive(t,kind,[{name}]);await assert.rejects(pack.extractArchive(f.file,f.out,{kind,root:'root'}),/archive/i);
 }
 for(const entries of [[{name:'root/A/x'},{name:'root/a/y'}],[{name:'root/a'},{name:'root/a'}],[{name:'root/x',type:'link',to:'outside'}],[{name:'root/x',type:'hard',to:'root/y'}],[{name:'root/x',type:'fifo'}]]) {
  const f=await archive(t,'tar',entries);await assert.rejects(pack.extractArchive(f.file,f.out,{kind:'tar',root:'root'}),/archive/i);
 }
});
test('safe runtime legal links become independent files; escape, cycle and nonlegal links fail',async t=>{
 const good=await archive(t,'tar',[{name:'root/legal/base/LICENSE',data:'license'},{name:'root/legal/other/LICENSE',type:'link',to:'../base/LICENSE'}]);
 await pack.extractArchive(good.file,good.out,{kind:'tar',root:'root',runtimeLegalLinks:true});
 assert.equal(await fs.readFile(path.join(good.out,'legal/other/LICENSE'),'utf8'),'license');
 const a=await fs.lstat(path.join(good.out,'legal/other/LICENSE')),b=await fs.lstat(path.join(good.out,'legal/base/LICENSE'));assert.equal(a.nlink,1);assert.notEqual(a.ino,b.ino);
 for(const entries of [[{name:'root/legal/x',type:'link',to:'../../escape'}],[{name:'root/legal/a',type:'link',to:'b'},{name:'root/legal/b',type:'link',to:'a'}],[{name:'root/bin/java',type:'link',to:'../legal/x'}]]) {
  const f=await archive(t,'tar',entries);await assert.rejects(pack.extractArchive(f.file,f.out,{kind:'tar',root:'root',runtimeLegalLinks:true}),/archive/i);
 }
});
test('archive file/count/expanded bounds and corrupt archives fail closed',async t=>{
 for(const limits of [{maxEntries:1},{maxFileBytes:2},{maxExpandedBytes:2}]) {
  const f=await archive(t,'tar',[{name:'root/a',data:'abc'},{name:'root/b'}]);await assert.rejects(pack.extractArchive(f.file,f.out,{kind:'tar',root:'root',...limits}),/archive.*limit/i);
 }
 const f=await archive(t,'zip',[{name:'root/a'}]);await fs.truncate(f.file,20);await assert.rejects(pack.extractArchive(f.file,f.out,{kind:'zip',root:'root'}),/archive/i);
 const truncated=await archive(t,'tar',[{name:'root/a',data:'abc'}]);await fs.truncate(truncated.file,1024);await assert.rejects(pack.extractArchive(truncated.file,truncated.out,{kind:'tar',root:'root'}),/archive/i);
});
test('runtime OS/architecture and release metadata are checked rather than filenames',async()=>{
 const elf=Buffer.alloc(64);elf.write('\u007fELF');elf[4]=2;elf[5]=1;elf[7]=0;elf.writeUInt16LE(62,18);
 assert.doesNotThrow(()=>pack.verifyRuntimeBytes(elf,'JAVA_VERSION="17.0.21"\nOS_NAME="Linux"\nOS_ARCH="x86_64"\n','linux-x64'));
 assert.throws(()=>pack.verifyRuntimeBytes(elf,'JAVA_VERSION="17"\nOS_NAME="Windows"\nOS_ARCH="x86_64"','win32-x64'),/runtime/);
 elf.writeUInt16LE(183,18);assert.throws(()=>pack.verifyRuntimeBytes(elf,'JAVA_VERSION="17"\nOS_NAME="Linux"\nOS_ARCH="aarch64"','linux-x64'),/runtime/);
 const pe=Buffer.alloc(256);pe.write('MZ');pe.writeUInt32LE(64,60);pe.write('PE\0\0',64);pe.writeUInt16LE(0x8664,68);pe.writeUInt16LE(0x20b,88);const release='JAVA_VERSION="17.0.21"\nOS_NAME="Windows"\nOS_ARCH="x86_64"';assert.doesNotThrow(()=>pack.verifyRuntimeBytes(pe,release,'win32-x64'));pe.writeUInt16LE(0xaa64,68);assert.throws(()=>pack.verifyRuntimeBytes(pe,release,'win32-x64'),/runtime/);
});
test('existing nonempty output and symlink output are refused without overwrite',async t=>{
 const root=await area(t),out=path.join(root,'out');await fs.mkdir(out);await fs.writeFile(path.join(out,'keep'),'keep');
 await assert.rejects(pack.prepareOutput(out),/output/);assert.equal(await fs.readFile(path.join(out,'keep'),'utf8'),'keep');
 const alias=path.join(root,'alias');await fs.symlink(out,alias);await assert.rejects(pack.prepareOutput(alias),/output/);await assert.rejects(pack.prepareOutput(path.join(alias,'new')),/output/);
 const empty=path.join(root,'empty');await fs.mkdir(empty);await assert.rejects(pack.prepareOutput(empty),/output/);
});
test('inventory includes every regular file and rejects link aliases',async t=>{
 const root=await area(t);await fs.mkdir(path.join(root,'nested'));await fs.writeFile(path.join(root,'nested/a'),'a');await fs.writeFile(path.join(root,'b'),'b');
 const list=await pack.inventory(root);assert.deepEqual(list,[{path:'b',sha256:digest('b')},{path:'nested/a',sha256:digest('a')}]);
 await fs.link(path.join(root,'b'),path.join(root,'alias'));await assert.rejects(pack.inventory(root),/inventory/);
});
test('classpath is explicit, complete, ordered and rejects missing Hive closure',()=>{
 const jars=['z.jar','hive-jdbc-2.3.9.jar','a.jar'];
 const pins=require('../scripts/engine-dependencies.json');
 const cp=pack.makeClasspath(pins,jars);
 assert.equal(cp[0],'engine/app/classes');assert.equal(cp[1],'engine/drivers/gson-2.13.2.jar');assert.equal(cp[2],'engine/drivers/jsqlparser-5.3.jar');
 assert.deepEqual(cp.slice(-3),['engine/drivers/spark/a.jar','engine/drivers/spark/hive-jdbc-2.3.9.jar','engine/drivers/spark/z.jar']);assert(cp.every(p=>!p.includes('*')));
 assert.throws(()=>pack.makeClasspath(pins,['a.jar']),/Hive/);
});
test('failed build with missing dependency does not publish a manifest',async t=>{
 const root=await area(t),cache=path.join(root,'cache'),out=path.join(root,'out');await fs.mkdir(cache);
 await assert.rejects(pack.buildBundle({target:'linux-x64',out,cache,offline:true}),/offline.*missing/i);
 await assert.rejects(fs.access(path.join(out,'engine/manifest.json')));
});
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
async function area(t) { const p = await fs.mkdtemp(path.join(os.tmpdir(), 'task7a-test-')); t.after(() => fs.rm(p,{recursive:true,force:true})); return p; }
test('missing offline dependency fails actionably and digest mismatch never becomes trusted', async t => {
  const cache=await area(t), pin={id:'missing',filename:'missing.jar',sha256:'0'.repeat(64),maxBytes:100,url:'https://example.invalid/x'};
  await assert.rejects(pack.getArtifact(pin,{cache,offline:true}),/offline.*missing/i);
  await fs.writeFile(path.join(cache,pin.filename),'corrupt');
  await assert.rejects(pack.getArtifact(pin,{cache,offline:true}),/digest mismatch/);
  await fs.unlink(path.join(cache,pin.filename)); await fs.symlink('other',path.join(cache,pin.filename));
  await assert.rejects(pack.getArtifact(pin,{cache,offline:true}),/unsafe cache/i);
});
test('all-file manifest verification detects changed, missing and uninventoried bytes',async t=>{
 const root=await area(t);const names=['engine/runtime/bin/java','engine/runtime/lib/library','engine/native/gridbase-launcher','engine/app/classes/Main.class','engine/app/resources/VERSION','engine/app/resources/public/index.html'];
 for(const n of names){await fs.mkdir(path.dirname(path.join(root,n)),{recursive:true});await fs.writeFile(path.join(root,n),n.endsWith('VERSION')?'1.4.0\n':'synthetic fixture');}
 await fs.chmod(path.join(root,names[0]),0o700);await fs.chmod(path.join(root,names[2]),0o700);
 const manifest={schema:1,protocol:1,version:'1.4.0',platform:'linux',arch:'x64',java:names[0],resources:'engine/app/resources',classpath:['engine/app/classes'],files:await pack.inventory(root)};
 await fs.writeFile(path.join(root,'engine/manifest.json'),JSON.stringify(manifest));const {loadManifest}=require('../packages/local-engine/manifest');await loadManifest(root);
 const lib=path.join(root,'engine/runtime/lib/library');await fs.writeFile(lib,'tampered');await assert.rejects(loadManifest(root),{code:'INVALID_MANIFEST'});await fs.writeFile(lib,'synthetic fixture');
 await fs.writeFile(path.join(root,'unexpected'),'unlisted');await assert.rejects(loadManifest(root),{code:'INVALID_MANIFEST'});await fs.unlink(path.join(root,'unexpected'));await fs.unlink(lib);await assert.rejects(loadManifest(root),{code:'INVALID_MANIFEST'});
});
test('fetch rejects credentialed, nonofficial, token-query and non-HTTPS dependency URLs before network',async t=>{
 const cache=await area(t);for(const url of ['http://repo.maven.apache.org/x','https://user:secret@repo.maven.apache.org/x','https://example.invalid/x','https://raw.githubusercontent.com/a?token=synthetic'])await assert.rejects(pack.getArtifact({id:'bad',filename:'missing.jar',sha256:'0'.repeat(64),maxBytes:32,url},{cache}),/official HTTPS/);
});
test('public resource allowlist refuses unexpected environment, data or test material',async t=>{
 const root=await area(t),dest=path.join(root,'dest'),source=path.join(root,'public');await fs.mkdir(source);
 await fs.writeFile(path.join(source,'.env'),'synthetic forbidden fixture');await assert.rejects(pack.copyPublic(source,dest),/public resource allowlist/);await assert.rejects(fs.access(dest));
});
test('upstream SGID directory bits are discarded, never installed, while privileged files fail',async t=>{
 const f=await archive(t,'zip',[{name:'root/',mode:0o2770},{name:'root/file'}]);await pack.extractArchive(f.file,f.out,{kind:'zip',root:'root'});assert.equal((await fs.stat(f.out)).mode&0o6000,0);
 const g=await archive(t,'zip',[{name:'root/file',mode:0o4755}]);await assert.rejects(pack.extractArchive(g.file,g.out,{kind:'zip',root:'root'}),/archive/);
});
test('runtime license links and ZIP links cannot create aliases or escape through ancestors',async t=>{
 const f=await archive(t,'zip',[{name:'root/legal/link',type:'link',data:'../file'}]);await assert.rejects(pack.extractArchive(f.file,f.out,{kind:'zip',root:'root',runtimeLegalLinks:true}),/archive/);
 const g=await archive(t,'tar',[{name:'root/a',type:'link',to:'legal'},{name:'root/a/child'}]);await assert.rejects(pack.extractArchive(g.file,g.out,{kind:'tar',root:'root',runtimeLegalLinks:true}),/archive/);
});
test('cache leaf must be owner-controlled, not group/world writable',async t=>{
 const cache=await area(t);await fs.chmod(cache,0o777);await assert.rejects(pack.getArtifact({id:'missing',filename:'x.jar',sha256:'0'.repeat(64),maxBytes:32,url:'https://repo.maven.apache.org/x'},{cache,offline:true}),/unsafe cache directory/);await fs.chmod(cache,0o700);
});
test('extractor refuses symlink output parents and bounds compressed input size',async t=>{
 const f=await archive(t,'tar',[{name:'root/a'}]),dir=path.dirname(f.file),alias=path.join(dir,'alias');await fs.symlink(dir,alias);
 await assert.rejects(pack.extractArchive(f.file,path.join(alias,'new'),{kind:'tar',root:'root'}),/archive/);await assert.rejects(fs.access(path.join(dir,'new')));
 await assert.rejects(pack.extractArchive(f.file,f.out,{kind:'tar',root:'root',maxArchiveBytes:10}),/archive/);
});
test('overlapping cache and output are rejected even when child name begins dot-dot',async t=>{
 const cache=await area(t);await assert.rejects(pack.buildBundle({target:'linux-x64',cache,out:path.join(cache,'..child'),offline:true}),/overlapping cache/);
});
test('complete verified cache works offline without contacting upstream', async t => {
  const cache=await area(t), bytes=Buffer.from('accurately labeled synthetic unit-test bytes');
  const pin={id:'fixture',filename:'fixture.jar',sha256:digest(bytes),maxBytes:1024,url:'https://example.invalid/fixture.jar'};
  await fs.writeFile(path.join(cache,pin.filename),bytes);
  assert.deepEqual(await fs.readFile(await pack.getArtifact(pin,{cache,offline:true})),bytes);
});
