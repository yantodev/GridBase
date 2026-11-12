const test = require("node:test");
const assert = require("node:assert/strict");
const { extractDatabases, extractNamespaces, parseCsv, redactJdbcUrl, validateQuery, queryResultLimit } = require("../src/query-utils");

test("accepts a read-only query and removes a trailing semicolon", () => {
  const result = validateQuery("  SELECT id, name FROM users;  ");

  assert.deepEqual(result, {
    ok: true,
    sql: "SELECT id, name FROM users",
  });
});

test("accepts SQL to create, insert, update, delete, and manage tables", () => {
  for (const sql of [
    "CREATE TABLE users (id INT)",
    "INSERT INTO users VALUES (1)",
    "UPDATE users SET id = 2 WHERE id = 1",
    "DELETE FROM users WHERE id = 2",
    "DROP TABLE users",
    "ALTER TABLE users ADD COLUMN name STRING",
    "TRUNCATE TABLE users",
    "MERGE INTO users USING changes ON users.id = changes.id WHEN MATCHED THEN DELETE",
    "WITH values_to_insert AS (SELECT 1 AS id) INSERT INTO users SELECT id FROM values_to_insert",
  ]) assert.deepEqual(validateQuery(sql), { ok: true, sql });
});

test("preserves quoted SQL values and removes only actual comments", () => {
  const sql = "UPDATE users SET note = 'https://example.test/a--b/*value*/;delete' WHERE id = 1";
  assert.deepEqual(validateQuery(`-- update note\n${sql}; -- trailing note`), { ok: true, sql });
  assert.equal(validateQuery("SELECT 'can''t;delete', `update` FROM users").ok, true);
});

test("rejects multiple statements and client commands", () => {
  assert.equal(validateQuery("SELECT 1; DELETE FROM users").ok, false);
  assert.equal(validateQuery("SELECT 1;\n!sh touch /tmp/unwanted").ok, false);
  assert.equal(validateQuery("!quit").ok, false);
  assert.equal(validateQuery("-- comment only").ok, false);
  assert.equal(validateQuery("SELECT '\0'").ok, false);
});

test("rejects empty and oversized queries", () => {
  assert.equal(validateQuery("   ").ok, false);
  assert.equal(validateQuery("SELECT 1", { maxLength: 4 }).ok, false);
});

test("parses quoted commas and escaped quotes from Beeline CSV output", () => {
  const result = parseCsv('id,name,note\n1,"Ari, Bima","He said ""hello"""');

  assert.deepEqual(result.columns, ["id", "name", "note"]);
  assert.deepEqual(result.rows, [{ id: "1", name: "Ari, Bima", note: 'He said "hello"' }]);
});

test("keeps a quoted multiline cell in one result row", () => {
  const result = parseCsv('id,note\n1,"line one\nline two"\n2,done');

  assert.deepEqual(result.rows, [
    { id: "1", note: "line one\nline two" },
    { id: "2", note: "done" },
  ]);
});

test("redacts credentials embedded in a JDBC URL", () => {
  assert.equal(
    redactJdbcUrl("jdbc:hive2://host/default;password=super-secret;ssl=true"),
    "jdbc:hive2://host/default;password=••••••;ssl=true",
  );
});

test("extracts unique databases from Spark SHOW DATABASES output", () => {
  const result = parseCsv("namespace\ndefault\nanalytics\ndefault\n");

  assert.deepEqual(extractDatabases(result), ["default", "analytics"]);
});

test("supports Hive-style databaseName output", () => {
  const result = parseCsv("databaseName\nwarehouse\n");

  assert.deepEqual(extractDatabases(result), ["warehouse"]);
  assert.deepEqual(extractNamespaces(result), ["warehouse"]);
});


test("honors outer SQL LIMIT and uses 50 only when absent or NULL", () => {
  const plan = (sql) => queryResultLimit(sql, 50);
  assert.deepEqual(plan('SELECT * FROM users LIMIT 20'), { sql:'SELECT * FROM users LIMIT 20', rowLimit:null });
  assert.equal(plan('SELECT * FROM users LIMIT 75').rowLimit, null);
  assert.equal(plan('SELECT * FROM `users` LIMIT 75').rowLimit,null);
  assert.equal(plan('SELECT * FROM users ORDER BY `id` LIMIT 75').rowLimit,null);
  assert.equal(plan('SELECT * FROM `users` LIMIT NULL').sql,'SELECT * FROM `users` LIMIT 50');
  assert.equal(plan('SELECT 1 LIMIT 20').rowLimit,null);
  assert.equal(plan('SELECT * FROM users LIMIT 25+50').rowLimit,null);
  assert.equal(plan('WITH limit AS (SELECT * FROM users) SELECT * FROM limit').rowLimit,50);
  assert.equal(plan('SELECT * FROM users WHERE limit > 20').rowLimit,50);
  assert.equal(plan('SELECT * FROM users WHERE id > limit+1').rowLimit,50);
  assert.equal(plan('SELECT * FROM users ORDER BY id, limit+1 DESC').rowLimit,50);
  assert.deepEqual(plan('SELECT * FROM users'), { sql:'SELECT * FROM users', rowLimit:50 });
  assert.deepEqual(plan('SELECT * FROM users LIMIT NULL'), { sql:'SELECT * FROM users LIMIT 50', rowLimit:50 });
  assert.equal(plan('SELECT * FROM users LIMIT 0').rowLimit, null);
  assert.equal(plan("SELECT 'LIMIT 20', `limit` FROM users").rowLimit, 50);
  assert.equal(plan('SELECT * FROM (SELECT * FROM users LIMIT 20) t').rowLimit, 50);
  assert.equal(plan('WITH t AS (SELECT * FROM users LIMIT 20) SELECT * FROM t').rowLimit, 50);
  assert.equal(plan('WITH t AS (SELECT * FROM users LIMIT 20) SELECT * FROM t LIMIT 75 OFFSET 5').rowLimit, null);
  assert.equal(plan('SELECT * FROM users LIMIT (10 + 65)').rowLimit, null);
  assert.equal(plan('SELECT * FROM users LIMIT ALL').rowLimit, null);
  assert.equal(plan('SELECT limit FROM users').rowLimit, 50);
  assert.equal(plan('SELECT * FROM users -- LIMIT 20').rowLimit, 50);
  const write='WITH t AS (SELECT 1) INSERT INTO users SELECT * FROM t';
  assert.equal(plan(write).sql,write);
  assert.equal(plan('UPDATE users SET note = \'LIMIT NULL\'').sql,'UPDATE users SET note = \'LIMIT NULL\'');
});
