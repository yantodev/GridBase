'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path'); const { spawnSync } = require('node:child_process'); const crypto = require('node:crypto');
const { writeManifest } = require('./fixture.cjs');
const { buildLauncher } = require('../native/build.cjs');
const root = path.resolve(__dirname, '../../..');
const JAVA = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : '/usr/lib/jvm/java-17-openjdk-amd64/bin/java';
async function realBundle(t) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-real-java 空 ')); await fs.chmod(fixture, 0o700); t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const bundleDir = path.join(fixture, 'bundle'); await fs.mkdir(path.join(bundleDir, 'resources/public'), { recursive: true });
  await fs.writeFile(path.join(bundleDir, 'resources/VERSION'), '1.4.0\n'); await fs.writeFile(path.join(bundleDir, 'resources/public/index.html'), 'fixture');
  // Dereference runtime code; Ubuntu's optional src.zip is a broken source-only
  // symlink on this host and is not part of a distributable runtime image.
  await fs.cp(path.dirname(path.dirname(JAVA)), path.join(bundleDir, 'jre'), { recursive: true, dereference: true, filter: source => !source.endsWith('/src.zip') });
  const cp = ['classes', 'lib/gson.jar','lib/jsqlparser.jar','lib/sqlite-jdbc.jar','lib/slf4j.jar'];
  const sources = [
    ['lib/gson.jar','build/deps/gson.jar','dd0ce1b55a3ed2080cb70f9c655850cda86c206862310009dcb5e5c95265a5e0'],
    ['lib/jsqlparser.jar','build/deps/jsqlparser.jar','41bcb5b00488231db179cb5a375690830a59aba521dfa303daa94dcb9dcc8e88'],
    ['lib/sqlite-jdbc.jar','build/deps/sqlite-jdbc.jar','f8dce420a6016278497f4f0560f65602b9db858de141b541cf91a4644ebe4639'],
    ['lib/slf4j.jar',path.join(process.env.SPARK_HOME || '/home/coder/.local/opt/pyspark-3.5.6/deps','jars/slf4j-api-2.0.7.jar'),'5d6298b93a1905c32cda6478808ac14c2d4a47e91535e53c41f7feeb85d946f4']
  ];
  await fs.mkdir(path.join(bundleDir, 'lib'));
  for (const [dest, src, expected] of sources) { const bytes = await fs.readFile(path.resolve(root, src)); assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected); await fs.writeFile(path.join(bundleDir, dest), bytes); }
  await fs.cp(path.join(root, 'build/java-tests'), path.join(bundleDir, 'classes'), { recursive: true, dereference: true });
  await buildLauncher(path.join(bundleDir, 'engine/native/gridbase-launcher'));
  await writeManifest(bundleDir, 'jre/bin/java', cp);
  return { root: fixture, bundleDir, dataDir: path.join(fixture, 'data'), tempDir: path.join(fixture, 'temp'), clientKind: 'desktop', credentialKey: Buffer.alloc(32, 19) };
}
async function addJdbcFixture(f) {
  const source = path.join(f.root, 'Driver.java');
  await fs.writeFile(source, `package org.postgresql;
public final class Driver implements java.sql.Driver {
  static { try { java.sql.DriverManager.registerDriver(new Driver()); } catch (Exception e) { throw new ExceptionInInitializerError(e); } }
  public java.sql.Connection connect(String u, java.util.Properties p) {
    if (!acceptsURL(u)) return null;
    return (java.sql.Connection) java.lang.reflect.Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{java.sql.Connection.class}, (proxy,m,a) -> {
      return switch(m.getName()) {
        case "isValid" -> true;
        case "setReadOnly", "close" -> null;
        case "createStatement" -> java.lang.reflect.Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{java.sql.Statement.class}, (s,n,b) -> {
          switch(n.getName()) {
            case "execute":
              var dir = java.nio.file.Path.of(System.getenv("HOME"));
              java.nio.file.Files.writeString(dir.resolve("jdbc-writes"), "execute\\n", java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
              long end = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(40);
              while (!java.nio.file.Files.exists(dir.resolve("jdbc-release"))) { if (System.nanoTime()>end) throw new java.sql.SQLException(); try { Thread.sleep(10); } catch (InterruptedException ignored) {} }
              return false;
            case "getUpdateCount": return 1;
            case "setQueryTimeout", "close": return null;
            default: throw new UnsupportedOperationException();
          }
        });
        default -> throw new UnsupportedOperationException();
      };
    });
  }
  public boolean acceptsURL(String u) { return u.startsWith("jdbc:postgresql:"); }
  public java.sql.DriverPropertyInfo[] getPropertyInfo(String u, java.util.Properties p) { return new java.sql.DriverPropertyInfo[0]; }
  public int getMajorVersion() { return 1; } public int getMinorVersion() { return 0; }
  public boolean jdbcCompliant() { return false; } public java.util.logging.Logger getParentLogger() { return java.util.logging.Logger.getGlobal(); }
}`);
  const result = spawnSync(path.join(path.dirname(JAVA), 'javac'), ['--release','17','-d',path.join(f.bundleDir, 'classes'), source], { env: { LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  await writeManifest(f.bundleDir, 'jre/bin/java', ['classes','lib/gson.jar','lib/jsqlparser.jar','lib/sqlite-jdbc.jar','lib/slf4j.jar']);
}
module.exports = { realBundle, addJdbcFixture, root };
