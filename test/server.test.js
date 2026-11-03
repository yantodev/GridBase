const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildBeelineArgs, createServer, DATABASE_LIST_SQL, describeBeelineSpawnError, getHealth, resolveBeelineBin } = require("../server");

test("creates an HTTP server without opening a network socket", () => {
  const server = createServer();

  assert.equal(typeof server.listen, "function");
  assert.equal(server.listening, false);
});

test("reports a valid read-only health state", () => {
  const health = getHealth();

  assert.equal(health.readOnly, true);
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

test("qualifies sidebar table queries with the s3tables catalog", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

  assert.ok(appSource.includes("SHOW TABLES IN \\`s3tables\\`.\\`${escapedNamespace}\\`;"));
});

test("makes table names load data from the selected s3tables table", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

  assert.ok(appSource.includes("SELECT * FROM \\`s3tables\\`.\\`${escapeSqlIdentifier(namespace)}\\`.\\`${escapeSqlIdentifier(tableName)}\\` LIMIT 1000;"));
  assert.ok(appSource.includes("runQuery();"));
});

test("keeps inactive result states hidden", () => {
  const styles = fs.readFileSync(path.join(__dirname, "../public/styles.css"), "utf8");

  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test("supports opening a transposed detail view for result rows", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

  assert.match(htmlSource, /id="row-detail"/);
  assert.ok(appSource.includes("openRowDetail(row, result.columns, tableRow)"));
  assert.ok(appSource.includes("rowDetail.hidden = false"));
});

test("uses the compact query studio workspace header", () => {
  const htmlSource = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

  assert.match(htmlSource, /<h1 id="page-title">Query studio<\/h1>/);
  assert.doesNotMatch(htmlSource, /Ask the warehouse|better questions\.|A focused desk for exploring your Spark data/);
});

