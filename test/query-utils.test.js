const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv, redactJdbcUrl, validateQuery } = require("../src/query-utils");

test("accepts a read-only query and removes a trailing semicolon", () => {
  const result = validateQuery("  SELECT id, name FROM users;  ");

  assert.deepEqual(result, {
    ok: true,
    sql: "SELECT id, name FROM users",
  });
});

test("rejects mutation queries in read-only mode", () => {
  const result = validateQuery("DROP TABLE users");

  assert.equal(result.ok, false);
  assert.match(result.error, /hanya mengizinkan/i);
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

test("redacts credentials embedded in a JDBC URL", () => {
  assert.equal(
    redactJdbcUrl("jdbc:hive2://host/default;password=super-secret;ssl=true"),
    "jdbc:hive2://host/default;password=••••••;ssl=true",
  );
});

