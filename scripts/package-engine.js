'use strict';
// Build-time API. Never imported by the deployed engine host.
const fs=require('node:fs/promises'), path=require('node:path'), crypto=require('node:crypto');
async function sha256(file) { const h=crypto.createHash('sha256');const f=await fs.open(file,'r');try { for await(const b of f.createReadStream()) h.update(b); } finally { await f.close(); } return h.digest('hex'); }
async function safeDirectory(dir,create=false) {
  if(typeof dir!=='string'||!path.isAbsolute(dir)||path.normalize(dir)!==dir||dir===path.parse(dir).root)throw Error('unsafe directory');
  if(create) { await safeDirectory(path.dirname(dir)); await fs.mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;}); }
  let part=path.parse(dir).root; for(const item of dir.slice(part.length).split(path.sep)) {part=path.join(part,item);const st=await fs.lstat(part);if(!st.isDirectory()||st.isSymbolicLink())throw Error('unsafe directory');}
}
const OFFICIAL=new Set(['repo.maven.apache.org','files.pythonhosted.org','github.com','raw.githubusercontent.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);
function officialUrl(value,redirect=false) {const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||(!redirect&&u.search)||!OFFICIAL.has(u.hostname))throw Error('dependency URL must be official HTTPS without credentials or token query');return u;}
async function download(url,handle,maxBytes,redirects=0,deadline=Date.now()+900000) {
 const u=officialUrl(url,redirects>0);if(redirects>5||Date.now()>=deadline)throw Error('dependency download timeout/redirect limit');
 await new Promise((resolve,reject)=>{const req=require('node:https').get(u,{timeout:30000},res=>{
  (async()=>{if([301,302,303,307,308].includes(res.statusCode)){res.destroy();if(!res.headers.location)throw Error('dependency redirect missing location');await download(new URL(res.headers.location,u).href,handle,maxBytes,redirects+1,deadline);return;}
   if(res.statusCode!==200){res.destroy();throw Error('dependency HTTP status '+res.statusCode);}
   if(res.headers['content-length']&&(!/^\d+$/.test(res.headers['content-length'])||Number(res.headers['content-length'])>maxBytes)){res.destroy();throw Error('dependency download size limit');}
   let size=0;for await(const chunk of res){size+=chunk.length;if(size>maxBytes||Date.now()>deadline){res.destroy();throw Error('dependency download size/time limit');}await handle.writeFile(chunk);}
  })().then(resolve,reject);
 });req.once('timeout',()=>req.destroy(Error('dependency download timeout')));req.once('error',reject);});
}
async function getArtifact(pin,{cache,offline=false}) {
  await safeDirectory(cache); const cacheStat=await fs.stat(cache);if(cacheStat.uid!==process.getuid()||(cacheStat.mode&0o022))throw Error('unsafe cache directory: owner-only write required'); if(!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(pin.filename)||!/^[a-f0-9]{64}$/.test(pin.sha256)||!Number.isSafeInteger(pin.maxBytes)||pin.maxBytes<1)throw Error('invalid dependency pin');
  const file=path.join(cache,pin.filename); let st;try{st=await fs.lstat(file);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(st) {if(!st.isFile()||st.nlink!==1)throw Error('unsafe cache file: '+pin.id);if(st.size>pin.maxBytes||await sha256(file)!==pin.sha256)throw Error('digest mismatch: '+pin.id);return file;}
  if(offline)throw Error('offline cache missing dependency: '+pin.id+' ('+pin.filename+')');
  const partial=path.join(cache,'.download-'+crypto.randomBytes(12).toString('hex'));let handle;
  try {handle=await fs.open(partial,'wx',0o600);await download(pin.url,handle,pin.maxBytes);await handle.close();handle=null;if(await sha256(partial)!==pin.sha256)throw Error('digest mismatch: '+pin.id);await fs.link(partial,file);await fs.unlink(partial);return file;}
  finally {if(handle)await handle.close();await fs.unlink(partial).catch(()=>{});}
}
const {spawn}=require('node:child_process');
async function run(command,args,options={}) {
 return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:options.cwd,env:options.env||{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});let output='';const timer=setTimeout(()=>child.kill('SIGKILL'),options.timeout||120000);for(const s of [child.stdout,child.stderr])s.on('data',b=>{if(output.length<32000)output+=b.toString();});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error('build command failed ('+code+'): '+output));});});
}
async function extractArchive(source,out,options) { await run('python3',[path.join(__dirname,'package-engine/extract.py'),'extract',source,out,JSON.stringify(options)]); }
function verifyRuntimeBytes(bytes,release,target) {
 const fields=Object.fromEntries([...release.matchAll(/^([A-Z_]+)="([^"]*)"$/gm)].map(m=>[m[1],m[2]]));
 if(!/^17(?:\.|$)/.test(fields.JAVA_VERSION)||fields.OS_ARCH!=='x86_64')throw Error('runtime release architecture/version');
 if(target==='linux-x64') { if(fields.OS_NAME!=='Linux'||bytes.length<64||bytes.subarray(0,4).toString('hex')!=='7f454c46'||bytes[4]!==2||bytes[5]!==1||bytes.readUInt16LE(18)!==62)throw Error('runtime wrong ELF OS/architecture'); }
 else if(target==='win32-x64') { const offset=bytes.length>=64?bytes.readUInt32LE(60):0;if(fields.OS_NAME!=='Windows'||bytes.subarray(0,2).toString()!=='MZ'||offset<64||offset+26>bytes.length||bytes.subarray(offset,offset+4).toString('hex')!=='50450000'||bytes.readUInt16LE(offset+4)!==0x8664||bytes.readUInt16LE(offset+24)!==0x20b)throw Error('runtime wrong PE OS/architecture'); }
 else throw Error('runtime unsupported target');
}
async function prepareOutput(out) {
 try {await safeDirectory(path.dirname(out));if(!path.isAbsolute(out)||path.normalize(out)!==out||out.includes(':')||out.includes(';')||out===path.parse(out).root)throw Error();let st;try{st=await fs.lstat(out);}catch(e){if(e.code!=='ENOENT')throw e;}if(st)throw Error();}
 catch {throw Error('unsafe/existing nonempty output directory');}
}
function portable(name) { if(!name||name.length>4096||/[\\\\:;*?"<>|\x00-\x1f\x7f]/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('inventory unsafe path'); }
async function inventory(root) {
 const files=[],aliases=new Map();let count=0;
 async function walk(dir,prefix='') {for(const entry of (await fs.readdir(dir)).sort()) {if(++count>40000)throw Error('inventory entry limit');const name=prefix+entry;portable(name);const lower=name.toLowerCase();if(aliases.has(lower)&&aliases.get(lower)!==name)throw Error('inventory case alias');aliases.set(lower,name);const file=path.join(dir,entry),st=await fs.lstat(file);if(st.isDirectory())await walk(file,name+'/');else if(st.isFile()&&st.nlink===1&&!(st.mode&0o6000)){if(name!=='engine/manifest.json')files.push({path:name,sha256:await sha256(file)});}else throw Error('inventory nonregular/link alias');}}
 await walk(root);if(files.length>20000)throw Error('inventory file limit');return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function makeClasspath(pins,sparkJars) {
 if(!sparkJars.includes('hive-jdbc-'+pins.hiveVersion+'.jar'))throw Error('incomplete Hive closure');
 const cp=['engine/app/classes'];
 for(const id of pins.classpathOrder) {
  if(id==='pyspark:all-jars-sorted')cp.push(...[...sparkJars].sort().map(n=>'engine/drivers/spark/'+n));
  else {const pin=pins.artifacts.find(p=>p.id===id);if(!pin||pin.kind!=='jar')throw Error('missing classpath dependency '+id);cp.push('engine/drivers/'+pin.filename);}
 }
 if(cp.length>1024||new Set(cp.map(x=>x.toLowerCase())).size!==cp.length)throw Error('classpath limit/alias');cp.forEach(portable);return cp;
}
const ROOT=path.resolve(__dirname,'..');
const SOURCES=['ActivityApi','ActivityAudit','Actor','AppConfig','AuditStore','AuthConfig','ConnectionProfile','ConnectionRegistry','ConnectionSettings','ConnectionStore','ConnectionWorkspaces','CredentialKey','DatabaseType','GitHubAuth','JdbcService','JsonUtil','LocalAuth','LocalEngineMain','LocalMcpControl','LocalWorkspace','McpApi','McpAudit','McpExecutionPolicy','McpServer','McpSqlPolicy','McpTokenStore','PrivateFiles','QueryLimits','RequestAuth','SqlPolicy','StrictJson','ThriftQueryServer'];
async function copyTree(source,dest) {
 const st=await fs.lstat(source);if(st.isDirectory()){await fs.mkdir(dest,{recursive:true,mode:0o700});for(const name of (await fs.readdir(source)).sort()){portable(name);await copyTree(path.join(source,name),path.join(dest,name));}}
 else if(st.isFile()&&st.nlink===1&&!(st.mode&0o6000)){await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o700});await fs.copyFile(source,dest,require('node:fs').constants.COPYFILE_EXCL);await fs.chmod(dest,st.mode&0o111?0o700:0o600);await fs.utimes(dest,0,0);}else throw Error('unsafe build input file');
}
async function normalize(root) {for(const n of await fs.readdir(root)){const f=path.join(root,n),s=await fs.lstat(f);if(s.isDirectory())await normalize(f);else if(s.isFile()&&s.nlink===1){await fs.chmod(f,s.mode&0o111?0o700:0o600);await fs.utimes(f,0,0);}else throw Error('unsafe build output');}await fs.chmod(root,0o700);await fs.utimes(root,0,0);}
async function writeJson(file,value){await fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
async function buildBundle({target,out,cache,offline=false,dependencies=require('./engine-dependencies.json'),buildJdk=process.env.JAVA_HOME}) {
 if(!['linux-x64','win32-x64'].includes(target)||process.platform!=='linux'||process.arch!=='x64')throw Error('unsupported build host/target (Linux x64 build tooling required)');
 await prepareOutput(out);await safeDirectory(cache,true);
 const inside=(a,b)=>{const r=path.relative(a,b);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));};
 if(inside(cache,out)||inside(out,cache))throw Error('unsafe overlapping cache/output');
 const selected=dependencies.artifacts.filter(p=>!p.targets||p.targets.includes(target)),artifacts=new Map();
 for(const pin of selected)artifacts.set(pin.id,await getArtifact(pin,{cache,offline}));
 const scratch=require('node:os').tmpdir();await safeDirectory(scratch);
 const work=await fs.mkdtemp(path.join(scratch,'task7a-package-'));let published=false,createdOutput=false;
 try {
  const bundle=path.join(work,'bundle'),engine=path.join(bundle,'engine');await fs.mkdir(engine,{recursive:true,mode:0o700});
  const runtimePin=selected.find(p=>p.id==='jre-'+target);if(!runtimePin)throw Error('missing runtime pin');
  const runtime=path.join(engine,'runtime');await extractArchive(artifacts.get(runtimePin.id),runtime,{kind:runtimePin.kind,root:runtimePin.root,runtimeLegalLinks:target==='linux-x64'});
  const java='engine/runtime/bin/'+(target==='linux-x64'?'java':'java.exe');verifyRuntimeBytes(await fs.readFile(path.join(bundle,java)),await fs.readFile(path.join(runtime,'release'),'utf8'),target);
  const sparkPin=selected.find(p=>p.id==='pyspark'),spark=path.join(work,'spark');if(!sparkPin)throw Error('missing Hive closure pin');
  await extractArchive(artifacts.get('pyspark'),spark,{kind:sparkPin.kind,root:sparkPin.root});
  const jars=(await fs.readdir(path.join(spark,'deps/jars'))).sort();if(jars.some(n=>!n.endsWith('.jar'))||jars.length!==252)throw Error('incomplete/changed Hive closure (expected all 252 PySpark jars)');
  const licenses=path.join(engine,'licenses');await fs.mkdir(licenses,{mode:0o700});
  await copyTree(path.join(spark,'deps/jars'),path.join(engine,'drivers/spark'));await copyTree(path.join(spark,'deps/licenses'),path.join(licenses,'spark-upstream'));
  for(const pin of selected){if(pin.kind==='jar')await copyTree(artifacts.get(pin.id),path.join(engine,'drivers',pin.filename));else if(pin.kind==='text')await copyTree(artifacts.get(pin.id),path.join(licenses,pin.filename));}
  const classpath=makeClasspath(dependencies,jars),classes=path.join(engine,'app/classes');await fs.mkdir(classes,{recursive:true,mode:0o700});
  if(typeof buildJdk!=='string'||!path.isAbsolute(buildJdk))throw Error('set JAVA_HOME to a trusted build JDK17');
  const javac=path.join(buildJdk,'bin/javac');if(!/javac 17\./.test(await run(javac,['-version'])))throw Error('build requires trusted JDK17');
  const sourceDir=path.join(ROOT,'java-service/src/com/peentar/thriftquery');
  const actual=(await fs.readdir(sourceDir)).filter(n=>n.endsWith('.java')&&!n.endsWith('Test.java')).sort();if(JSON.stringify(actual)!==JSON.stringify(SOURCES.map(n=>n+'.java').sort()))throw Error('production Java source allowlist changed; review required');
  await run(javac,['--release','17','--add-modules','jdk.httpserver','-encoding','UTF-8','-implicit:none','-sourcepath','', '-cp',classpath.slice(1).map(n=>path.join(bundle,n)).join(path.delimiter),'-d',classes,...SOURCES.map(n=>path.join(sourceDir,n+'.java'))]);
  for(const file of await inventory(classes)){if(/(?:Test|Fixture|Helper)/i.test(file.path)||!file.path.endsWith('.class'))throw Error('test/helper class leaked');const bytes=await fs.readFile(path.join(classes,file.path));if(bytes.readUInt32BE(0)!==0xcafebabe||bytes.readUInt16BE(6)!==61)throw Error('non-release17 class');}
  await copyTree(path.join(ROOT,'VERSION'),path.join(engine,'app/resources/VERSION'));await copyPublic(path.join(ROOT,'public'),path.join(engine,'app/resources/public'));
  const version=(await fs.readFile(path.join(ROOT,'VERSION'),'utf8')).trim();if(version!==require('../package.json').version)throw Error('version mismatch');
  if(target==='linux-x64')await require('../packages/local-engine/native/build.cjs').buildLauncher(path.join(engine,'native/gridbase-launcher'));
  else require('../packages/local-engine/native/windows/build.cjs').build(path.join(engine,'native/win32-x64'));
  const jarInventory=[];await fs.mkdir(path.join(licenses,'jars'),{mode:0o700});
  for(const entry of classpath.slice(1)) {const file=path.join(bundle,entry),name=path.basename(entry);const noticeDir=path.join(licenses,'jars',name);await run('python3',[path.join(__dirname,'package-engine/extract.py'),'notices',file,noticeDir]);const notices=JSON.parse(await fs.readFile(path.join(noticeDir,'entries.json'),'utf8'));jarInventory.push({path:entry,sha256:await sha256(file),bytes:(await fs.stat(file)).size,source:entry.includes('/spark/')?'pyspark-3.5.6.tar.gz':selected.find(p=>p.filename===name).id,notices:'engine/licenses/jars/'+name+'/entries.json',noticeCount:notices.length});}
  await copyTree(path.join(__dirname,'package-engine/THIRD_PARTY_NOTICES.md'),path.join(licenses,'THIRD_PARTY_NOTICES.md'));
  await writeJson(path.join(licenses,'dependencies.json'),{schema:1,target,artifacts:selected,jars:jarInventory});
  await writeJson(path.join(licenses,'production-sources.json'),await Promise.all(SOURCES.map(async n=>({path:'java-service/src/com/peentar/thriftquery/'+n+'.java',sha256:await sha256(path.join(sourceDir,n+'.java'))}))));
  await writeJson(path.join(licenses,'build-inputs.json'),{schema:1,javaRelease:17,dependencyPinsSha256:await sha256(path.join(__dirname,'engine-dependencies.json')),buildJdkVersion:(await run(javac,['-version'])).trim()});
  await normalize(bundle);const files=await inventory(bundle);const manifest={schema:1,protocol:1,version,platform:target==='linux-x64'?'linux':'win32',arch:'x64',java,resources:'engine/app/resources',classpath,files};
  await writeJson(path.join(engine,'manifest.json'),manifest);await fs.utimes(path.join(engine,'manifest.json'),0,0);
  if(target==='linux-x64')await require('../packages/local-engine/manifest').loadManifest(bundle);
  // Reserve a new directory exclusively. Publish manifest LAST, so a failed copy
  // cannot look like a completed bundle. Never remove/overwrite user output.
  await fs.mkdir(out,{mode:0o700});createdOutput=true;
  for(const name of await fs.readdir(engine))if(name!=='manifest.json')await copyTree(path.join(engine,name),path.join(out,'engine',name));
  await normalize(out);
  await copyTree(path.join(engine,'manifest.json'),path.join(out,'engine/manifest.json'));
  if(JSON.stringify(await inventory(out))!==JSON.stringify(files))throw Error('published inventory mismatch');
  if(target==='linux-x64')await require('../packages/local-engine/manifest').loadManifest(out);
  await fs.utimes(path.join(out,'engine'),0,0);await fs.utimes(out,0,0);published=true;
  return {out,target,manifest:path.join(out,'engine/manifest.json'),manifestSha256:await sha256(path.join(out,'engine/manifest.json')),files:files.length,jars:jarInventory.length};
 } finally {if(createdOutput&&!published)await fs.unlink(path.join(out,'engine/manifest.json')).catch(()=>{});await fs.rm(work,{recursive:true,force:true});}
}
if(require.main===module) {
 (async()=>{const options={offline:false};const args=process.argv.slice(2);for(let i=0;i<args.length;i++){const arg=args[i];if(arg==='--offline'){options.offline=true;continue;}if(!['--target','--out','--cache'].includes(arg)||!args[i+1]||args[i+1].startsWith('--'))throw Error('usage: node scripts/package-engine.js --target linux-x64|win32-x64 --out ABSOLUTE_NEW_DIRECTORY --cache ABSOLUTE_CACHE [--offline]');const key=arg.slice(2);if(options[key])throw Error('duplicate option');options[key]=args[++i];}if(!options.out||!options.cache||!options.target)throw Error('explicit --target, --out and --cache are required');console.log(JSON.stringify(await buildBundle(options)));})().catch(error=>{console.error(error.message);process.exitCode=1;});
}
const PUBLIC_FILES=['activity.js','app.js','index.html','local-session.js','login.html','login.js','mcp.js','runtime-transport.js','session.js','styles.css','workbench-core.js'];
async function copyPublic(source,dest){if(JSON.stringify((await fs.readdir(source)).sort())!==JSON.stringify(PUBLIC_FILES))throw Error('public resource allowlist changed; review required');return copyTree(source,dest);}
module.exports={getArtifact,sha256,extractArchive,verifyRuntimeBytes,prepareOutput,inventory,makeClasspath,buildBundle,copyPublic};
