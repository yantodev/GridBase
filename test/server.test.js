const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer, getHealth } = require("../server");

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

