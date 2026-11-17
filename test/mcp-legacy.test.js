'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createServer} = require('../server');

test('legacy backend explicitly rejects MCP transport and token APIs without accepting bearer auth', async () => {
  const server = createServer({environment:{}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/mcp','/api/mcp/tokens','/api/mcp/tokens/dummy']) {
      const response = await fetch(base + path, {method:'POST',redirect:'manual',headers:{Authorization:'Bearer dummy-fixture', 'Content-Type':'application/json'},body:'{}'});
      assert.equal(response.status, 501, path);
      assert.match((await response.json()).error, /Java/);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
