const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { buildBeelineArgs, createServer, DATABASE_LIST_SQL, describeBeelineSpawnError, getHealth, loadConnectionConfig, loadDotEnv, resolveBeelineBin } = require("../server");

test("loads connection credentials from .env while preserving environment overrides", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thrift-env-test-"));
  const envFile = path.join(directory, ".env");
  try {
    fs.writeFileSync(envFile, '# Local connection\nTHRIFT_JDBC_URL="jdbc:hive2://spark.example/default;token=hidden"\nTHRIFT_USERNAME=reader\nTHRIFT_PASSWORD=" secret=#value "\n');
    const environment = {};
    loadDotEnv(envFile, environment);
    const connection = loadConnectionConfig(environment);
    assert.equal(connection.jdbcUrl, "jdbc:hive2://spark.example/default;token=hidden");
    assert.equal(connection.username, "reader");
    assert.equal(connection.password, " secret=#value ");
    const override = { THRIFT_USERNAME: "environment-reader", THRIFT_PASSWORD: "environment-secret" };
    loadDotEnv(envFile, override);
    assert.equal(override.THRIFT_USERNAME, "environment-reader");
    assert.equal(override.THRIFT_PASSWORD, "environment-secret");
    assert.throws(() => loadConnectionConfig({ ...environment, THRIFT_JDBC_URL: "https://spark.example" }), /jdbc:hive2/);
    assert.throws(() => loadConnectionConfig({ ...environment, THRIFT_PASSWORD: "x".repeat(2049) }), /terlalu panjang/);
    assert.equal(loadConnectionConfig({}).password, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

test("uses separate metadata endpoints and qualified table SQL", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  assert.match(appSource, /\/api\/tables\?namespace=/);
  assert.match(appSource, /\/api\/columns\?namespace=/);
  assert.ok(appSource.includes("C.tableSql(namespace, table)"));
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

test("passes .env connection credentials to Docker at runtime", () => {
  const composeSource = fs.readFileSync(path.join(__dirname, "../compose.yaml"), "utf8");
  const dockerfileSource = fs.readFileSync(path.join(__dirname, "../Dockerfile"), "utf8");

  assert.match(composeSource, /HOST: 0\.0\.0\.0/);
  assert.match(composeSource, /THRIFT_QUERY_PORT:-4173\}:4173/);
  for (const name of ["THRIFT_JDBC_URL", "THRIFT_USERNAME", "THRIFT_PASSWORD"]) {
    assert.ok(composeSource.includes(`${name}: "\${${name}:-}"`));
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
