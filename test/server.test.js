const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { buildBeelineArgs, createServer, DATABASE_LIST_SQL, describeBeelineSpawnError, getHealth, loadConnectionConfig, loadDotEnv, resolveBeelineBin } = require("../server");

test("loads only server settings from .env and ignores old startup credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gridbase-env-test-"));
  const envFile = path.join(directory, ".env");
  try {
    fs.writeFileSync(envFile, 'PORT=4180\nQUERY_TIMEOUT_MS=45000\nDEFAULT_QUERY_LIMIT=75\nTHRIFT_JDBC_URL=jdbc:hive2://old-spark/default\nTHRIFT_USERNAME=fixture\nTHRIFT_PASSWORD=fixture-secret\nDATABASE_TYPE=hive\n');
    const environment = {};
    loadDotEnv(envFile, environment);
    assert.deepEqual(environment, {PORT:'4180',QUERY_TIMEOUT_MS:'45000',DEFAULT_QUERY_LIMIT:'75'});
    assert.equal(loadConnectionConfig(environment).jdbcUrl, '');
    const override = {PORT:'4181'}; loadDotEnv(envFile,override); assert.equal(override.PORT,'4181');
    // Explicit process settings remain supported by the legacy Beeline helper.
    assert.throws(() => loadConnectionConfig({THRIFT_JDBC_URL:'https://spark.example',THRIFT_USERNAME:'fixture',THRIFT_PASSWORD:'fixture'}), /jdbc:hive2/);
  } finally { fs.rmSync(directory, {recursive:true,force:true}); }
});

test("creates an HTTP server without opening a network socket", () => {
  const server = createServer();

  assert.equal(typeof server.listen, "function");
  assert.equal(server.listening, false);
});

test("reports a valid read/write health state", () => {
  const health = getHealth();

  assert.equal(health.readOnly, false);
  assert.equal(typeof health.configured, "boolean");
  assert.ok(["ok", "degraded"].includes(health.status));
});

test("explains when the Beeline executable is missing", () => {
  const message = describeBeelineSpawnError({ code: "ENOENT" }, "/opt/spark/bin/beeline");

  assert.match(message, /Beeline executable tidak ditemukan/);
  assert.match(message, /\/opt\/spark\/bin\/beeline/);
});

test("explains when the Beeline executable cannot be run", () => {
  const message = describeBeelineSpawnError({ code: "EACCES" }, "beeline");

  assert.match(message, /tidak bisa dijalankan/);
});

test("honors an explicit Beeline executable path", () => {
  assert.equal(
    resolveBeelineBin({ BEELINE_BIN: "/custom/spark/bin/beeline", PATH: "" }),
    "/custom/spark/bin/beeline",
  );
});

test("passes a password file path instead of a password argument", () => {
  const args = buildBeelineArgs({
    jdbcUrl: "jdbc:hive2://host/default",
    username: "reader",
    passwordFile: "/tmp/query-password",
  });

  assert.ok(args.includes("-w"));
  assert.ok(args.includes("/tmp/query-password"));
  assert.equal(args.includes("reader-password"), false);
});

test("uses the s3tables namespace query for the database list", () => {
  assert.equal(DATABASE_LIST_SQL, "SHOW NAMESPACES IN s3tables");
});


test("keeps inactive result states hidden", () => {
  const styles = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");

  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test("supports opening a transposed detail view for result rows", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

  assert.match(htmlSource, /id="row-detail"/);
  assert.match(appSource, /openRowDetail\(row,result.columns,index \+ 1\)/);
  assert.ok(appSource.includes("$('#row-detail').showModal()"));
});

test("provides the dark IDE shell, accessible console tabs and results dock", () => {
  const htmlSource = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");
  for (const id of ["console-tabs", "sql-editor", "sql-highlight", "results-resizer", "sidebar-resizer", "results-tab", "output-tab"]) {
    assert.ok(htmlSource.includes(`id="${id}"`));
  }
  assert.match(styles, /--editor: #1e1f22/);
  assert.match(styles, /@media \(max-width: 700px\)/);
  assert.match(htmlSource, /role="tablist"/);
});

test("uses server connection configuration without a browser credential form", () => {
  const htmlSource = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const javaSource = fs.readFileSync(path.join(__dirname, "../java-service/src/com/peentar/thriftquery/ThriftQueryServer.java"), "utf8");

  assert.doesNotMatch(htmlSource, /id="setup-(?:gate|form|password)"/);
  assert.doesNotMatch(appSource, /setupGate|submitSetup|\/api\/setup/);
  assert.match(appSource, /localStorage\.setItem\(HISTORY_STORAGE_KEY/);
  assert.doesNotMatch(appSource, /localStorage\.(?:getItem|setItem)\([^)]*password/i);
  assert.doesNotMatch(javaSource, /createContext\("\/api\/setup"|config\.configure\(/);
});

test("passes only server settings to Docker without a startup connection", () => {
  const composeSource = fs.readFileSync(path.join(__dirname, "../compose.yaml"), "utf8");
  const dockerfileSource = fs.readFileSync(path.join(__dirname, "../Dockerfile"), "utf8");

  assert.match(composeSource, /HOST: 0\.0\.0\.0/);
  assert.match(composeSource, /PORT:-4173\}:4173/);
  for (const name of ["THRIFT_JDBC_URL", "THRIFT_USERNAME", "THRIFT_PASSWORD"]) {
    assert.ok(!composeSource.includes(name));
  }
  assert.match(dockerfileSource, /FROM apache\/spark:3\.5\.6 AS spark/);
  assert.match(dockerfileSource, /SPARK_HOME=\/opt\/spark/);
  assert.match(dockerfileSource, /COPY --from=spark \/opt\/spark \/opt\/spark/);
  assert.match(dockerfileSource, /HEALTHCHECK/);
});


test('query HTTP handler honors explicit LIMIT while fallback remains 50', async () => {
  const { Readable } = require('node:stream');
  const { handleQuery } = require('../server');
  for (const [sql, expected, truncated] of [
    ['SELECT id FROM fixture LIMIT 20',20,false],
    ['SELECT id FROM fixture LIMIT 75',75,false],
    ['SELECT id FROM fixture',50,true],
    ['SELECT id FROM fixture LIMIT NULL',50,false],
  ]) {
    const request = Readable.from([JSON.stringify({sql})]);
    const response = { writeHead(status){this.status=status;},end(body){this.data=JSON.parse(body);} };
    await handleQuery(request,response,async executable=>{
      const match=executable.match(/LIMIT (\d+)$/i);
      const count=match?Number(match[1]):100;
      if(sql.endsWith('NULL'))assert.equal(executable,'SELECT id FROM fixture LIMIT 50');
      return {stdout:'id\n'+Array.from({length:count},(_,i)=>i+1).join('\n')+'\n'};
    });
    assert.equal(response.status,200);
    assert.equal(response.data.rows.length,expected,sql);
    assert.equal(response.data.rowCount,expected);
    assert.equal(response.data.truncated,truncated);
  }
});

test('uses the GridBase product name in UI, API and runtime packaging', () => {
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  assert.match(html,/<title>GridBase<\/title>/);
  assert.match(html,/<h1>GridBase<\/h1>/);
  assert.equal(require('../package.json').name,'gridbase');
});

test('legacy backend exposes its default source and rejects foreign IDs before execution', async () => {
  const { Readable } = require('node:stream');
  const { createServer, handleQuery } = require('../server');
  let executed=false;
  const response={writeHead(status){this.status=status;},end(body){this.data=JSON.parse(body);}};
  await handleQuery(Readable.from([JSON.stringify({sql:'DELETE FROM fixture',connectionId:'other-source'})]),response,async()=>{executed=true;});
  assert.equal(response.status,404);assert.equal(executed,false);
  const server=createServer({environment:{GITHUB_CLIENT_ID:'fixture',GITHUB_CLIENT_SECRET:'fixture'},identify:async()=> ({id:'1001',login:'fixture-user'})});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const cookie=await require('./auth-helpers').login(base);
    const headers={Cookie:cookie,'Content-Type':'application/json'};
    const sources=await (await fetch(base+'/api/connections',{headers})).json();
    assert.ok(Array.isArray(sources.connections));assert.ok(sources.connections.every(item=>item.id==='default'));
    assert.equal((await fetch(base+'/api/databases?connectionId=other-source',{headers})).status,404);
    assert.equal((await fetch(base+'/api/connections/connect',{method:'POST',headers})).status,501);
    for (const url of ['/api/activity','/api/activity/users']) assert.equal((await fetch(base+url,{headers})).status,501);
    assert.equal((await fetch(base+'/api/activity/exports',{method:'POST',headers,body:'{}'})).status,501);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
