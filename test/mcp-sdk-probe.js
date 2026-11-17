'use strict';
// Optional real SDK interoperability probe. SDK is installed outside the repository.
const assert = require('node:assert/strict');
const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
const {StreamableHTTPClientTransport} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
(async () => {
  const endpoint = new URL(process.env.GRIDBASE_MCP_FIXTURE_URL);
  assert.equal(endpoint.hostname,'127.0.0.1','Probe is local-fixture only');
  const client = new Client({name:'gridbase-fixture-probe',version:'1.0.0'});
  const transport = new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{Authorization:'Bearer '+process.env.GRIDBASE_MCP_FIXTURE_TOKEN}}});
  try {
    await client.connect(transport);
    const listing = await client.listTools();
    assert.deepEqual(listing.tools.map(tool=>tool.name).sort(),['describe_table','execute_query','list_connections','list_databases','list_tables']);
    const approved = await client.callTool({name:'list_connections',arguments:{}});
    assert.equal(approved.isError,false);
    assert.ok(JSON.parse(approved.content[0].text).connections.some(profile=>profile.id==='sdk-fixture'));
    const metadata = await client.callTool({name:'list_databases',arguments:{connectionId:'sdk-fixture'}});
    assert.equal(metadata.isError,false);
    assert.equal(JSON.parse(metadata.content[0].text).databases.length,1);
    assert.equal(JSON.parse(metadata.content[0].text).truncated,true,'Omitted duplicate metadata rows still report truncation');
    const queried = await client.callTool({name:'execute_query',arguments:{connectionId:'sdk-fixture',sql:'SELECT 1 AS fixture'}});
    assert.equal(queried.isError,false);
    assert.equal(JSON.parse(queried.content[0].text).rows[0].fixture,'1');
    const denied = await client.callTool({name:'execute_query',arguments:{connectionId:'sdk-fixture',sql:'DELETE FROM fixture'}});
    assert.equal(denied.isError,true);
    assert.ok(denied._meta.requestId);
    console.log('Actual MCP SDK: initialize, notification, listTools, approved query and read-only denial passed');
  } finally { await client.close(); }
})().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;});
