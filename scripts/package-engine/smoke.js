'use strict';
// Build/acceptance diagnostic only, not imported by the installed runtime.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');const {loadManifest}=require('../../packages/local-engine/manifest');const {EngineClient}=require('../../packages/local-engine');const {inventory}=require('../package-engine');
async function smokeDirectory(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) {
    throw Error('unsafe smoke path');
  }
  let component = path.parse(root).root;
  for (const name of root.slice(component.length).split(path.sep).filter(Boolean)) {
    component = path.join(component, name);
    const st = await fs.lstat(component);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error('unsafe smoke path');
  }
}
async function validateSmokeTree(root) {
  await smokeDirectory(root);
  try { await inventory(root); } catch { throw Error('unsafe smoke tree'); }
}
async function readonly(root) {
  // Validate the COMPLETE copied tree before changing even an ordinary sibling.
  // Concurrent malicious same-user replacement is outside this diagnostic's boundary.
  await validateSmokeTree(root);
  async function visit(directory) {
    const st = await fs.lstat(directory);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error('unsafe smoke tree');
    for (const name of await fs.readdir(directory)) {
      const file = path.join(directory, name), child = await fs.lstat(file);
      if (child.isDirectory() && !child.isSymbolicLink()) await visit(file);
      else if (child.isFile() && child.nlink === 1 && !(child.mode & 0o6000)) {
        await fs.chmod(file, child.mode & 0o111 ? 0o500 : 0o400);
      } else throw Error('unsafe smoke tree');
    }
    await fs.chmod(directory, 0o500);
  }
  await visit(root);
}
async function copySmokeTree(source, destination) {
  const st = await fs.lstat(source);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    await fs.mkdir(destination, { mode: 0o700 });
    for (const name of await fs.readdir(source)) {
      await copySmokeTree(path.join(source, name), path.join(destination, name));
    }
  } else if (st.isFile() && st.nlink === 1 && !(st.mode & 0o6000)) {
    await fs.copyFile(source, destination, require('node:fs').constants.COPYFILE_EXCL);
  } else throw Error('unsafe smoke tree');
}
async function smoke(bundleDir,work){
 await smokeDirectory(path.dirname(work));
 if (!path.isAbsolute(work) || path.normalize(work) !== work) throw Error('unsafe smoke path');
 const relative = path.relative(bundleDir, work), reverse = path.relative(work, bundleDir);
 const inside = value => value === '' || (value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value));
 if (inside(relative) || inside(reverse)) throw Error('unsafe smoke path');
 await validateSmokeTree(bundleDir);
 await fs.mkdir(work,{mode:0o700});
 const immutable=path.join(work,'read only ü runtime');
 await copySmokeTree(bundleDir,immutable);
 await readonly(immutable);
 const before=await inventory(immutable),m=await loadManifest(immutable),raw=JSON.parse(await fs.readFile(path.join(immutable,'engine/manifest.json'),'utf8'));
 assert.equal(raw.classpath.length,259);assert.equal(raw.files.length,before.length);assert(m.java.startsWith(immutable));
 const probe=path.join(work,'diagnostic');await fs.mkdir(probe,{mode:0o700});const temp=path.join(work,'diagnostic temp');await fs.mkdir(temp,{mode:0o700});
 const env={HOME:work,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:temp};
 const version=spawnSync(m.java,['--version'],{env,encoding:'utf8'});assert.equal(version.status,0,version.stderr);
 const javaSource=`import java.sql.*;public class BundleProbe {public static void main(String[] args)throws Exception {for(String c:new String[]{"org.postgresql.Driver","com.mysql.cj.jdbc.Driver","org.apache.hive.jdbc.HiveDriver","org.sqlite.JDBC"}) {Class.forName(c);System.out.println("DRIVER_LOADED "+c);}try(Connection c=DriverManager.getConnection("jdbc:sqlite:"+args[0])) {try(Statement s=c.createStatement()){s.executeUpdate("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");s.executeUpdate("INSERT INTO probe VALUES (1, 'bundled-runtime')");try(ResultSet r=s.executeQuery("SELECT value FROM probe WHERE id=1")){if(!r.next()||!r.getString(1).equals("bundled-runtime"))throw new Exception("SQLite readback");}}try(ResultSet r=c.getMetaData().getTables(null,null,"probe",null)){if(!r.next())throw new Exception("SQLite metadata");}try(var files=java.nio.file.Files.list(java.nio.file.Path.of(System.getProperty("org.sqlite.tmpdir")))){if(files.noneMatch(p->p.getFileName().toString().startsWith("sqlite-")))throw new Exception("SQLite native not extracted to private temp");}System.out.println("SQLITE_NATIVE_PRIVATE_TEMP_OK");System.out.println("SQLITE_NATIVE_RW_METADATA_OK");}}}`;
 const source=path.join(probe,'BundleProbe.java');await fs.writeFile(source,javaSource,{mode:0o600});
 const javac=path.join(process.env.JAVA_HOME||'','bin/javac');assert(path.isAbsolute(javac));const compile=spawnSync(javac,['--release','17','-d',probe,source],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},encoding:'utf8'});assert.equal(compile.status,0,compile.stderr);
 const jdbc=spawnSync(m.java,['-Djava.io.tmpdir='+temp,'-Dorg.sqlite.tmpdir='+temp,'-cp',m.classpath.join(path.delimiter)+path.delimiter+probe,'BundleProbe',path.join(work,'diagnostic.sqlite')],{env,encoding:'utf8',timeout:30000});assert.equal(jdbc.status,0,jdbc.stderr);assert(jdbc.stdout.includes('SQLITE_NATIVE_RW_METADATA_OK'));assert(jdbc.stdout.includes('SQLITE_NATIVE_PRIVATE_TEMP_OK'));
 const key=crypto.randomBytes(32),options={bundleDir:immutable,dataDir:path.join(work,'private data ü'),tempDir:path.join(work,'private temp ü'),clientKind:'desktop',credentialKey:key};
 let client,owner,exitProof;try{
  client=await EngineClient.start(options);client.onExit(p=>{exitProof=p;});
  assert.equal((await client.request({method:'GET',path:'/healthz'})).status,200);const session=JSON.parse((await client.request({method:'GET',path:'/api/auth/session'})).body);assert.equal(session.authenticated,true);assert.equal(session.mode,'local');owner=session.user.id;
  const profile={type:'postgresql',connectionId:'bundle-probe',name:'local synthetic profile (no connection attempted)',host:'127.0.0.1',port:'1',database:'unused',username:'synthetic',password:'synthetic-fixture-only'};
  assert.equal((await client.request({method:'POST',path:'/api/connections',body:profile})).status,200);
  const children=(await fs.readFile(`/proc/${process.pid}/task/${process.pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean);assert.equal(children.length,1);
  const child=children[0];assert.equal(await fs.readlink(`/proc/${child}/exe`),m.java);const childEnv=(await fs.readFile(`/proc/${child}/environ`)).toString().split('\0').filter(Boolean).map(e=>e.split('=')[0]).sort();assert.deepEqual(childEnv,['HOME','LANG','LC_ALL','TMPDIR']);
  await client.stop();assert.deepEqual(exitProof,{code:0,signal:null});client=null;
  client=await EngineClient.start(options);const again=JSON.parse((await client.request({method:'GET',path:'/api/auth/session'})).body);assert.equal(again.user.id,owner);const details=JSON.parse((await client.request({method:'GET',path:'/api/connections/bundle-probe'})).body);assert.equal(details.password,profile.password);
  assert.equal((await client.request({method:'GET',path:'/api/local/mcp'})).status,200);
  assert((await fs.readdir(options.tempDir)).some(x=>x.startsWith('sqlite-')));await client.stop();client=null;
 }finally{if(client)await client.stop();key.fill(0);}
 assert.deepEqual(await inventory(immutable),before);assert.equal((await fs.stat(options.dataDir)).mode&0o777,0o700);
 const result={bundleDir,readOnlyCopy:immutable,version:version.stdout.trim(),driverProbe:jdbc.stdout.trim().split('\n'),classpathEntries:raw.classpath.length,inventoryFiles:raw.files.length,bundledJavaExecutableVerified:true,childEnvironment:['HOME','LANG','LC_ALL','TMPDIR'],healthAuthenticated:true,localSession:true,ownerPersisted:true,syntheticProfileReopened:true,sqliteNativePrivateTemp:true,readonlyInventoryUnchanged:true,ownedShutdown:{code:0,signal:null},cannotVerify:['Live PostgreSQL/MySQL/Hive connectivity, metadata/query and credential paths','Native GUI/keyring/GTK and installed offline UI','Windows execution and installer trust']};
 await fs.writeFile(path.join(work,'smoke-results.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));return result;
}
if(require.main===module)smoke(process.argv[2],process.argv[3]).catch(e=>{console.error(e.stack);process.exitCode=1;});module.exports={smoke,readonly};
