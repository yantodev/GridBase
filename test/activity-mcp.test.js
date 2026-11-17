'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Logs safely displays MCP token identity and filters MCP token actions', async () => {
  class Node {
    constructor(tag='div') { this.tag=tag; this.children=[]; this.textContent=''; this.value=''; this.listeners={}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children=nodes; }
    addEventListener(type,fn) { this.listeners[type]=fn; }
    setAttribute() {}
  }
  const nodes = new Map();
  const get = key => { if (!nodes.has(key)) nodes.set(key,new Node()); return nodes.get(key); };
  const event = {requestId:'dummy-id',login:'alice',userId:'1001',startedAt:'fixture',action:'query.execute',source:'mcp',tokenId:'safe-token-id',tokenName:'<img src=x onerror=alert(1)>',sqlText:'SELECT 1',outcome:'failure',httpStatus:200};
  const window={}; const context=vm.createContext({window,document:{querySelector:get,createElement:tag=>new Node(tag)},URLSearchParams,Date});
  vm.runInContext(fs.readFileSync('public/activity.js','utf8'),context);
  const activity=window.GridBaseActivity.mount({api:async()=>({events:[event]}),user:{id:'1001'},capabilities:{}});
  await activity.show();
  const table=get('#activity-table');
  table.children[1].children[0].children.at(-1).children[0].listeners.click();
  assert.match(get('#activity-detail').textContent,/safe-token-id/);
  assert.match(get('#activity-detail').textContent,/<img src=x onerror=alert\(1\)>/);
  assert.equal(get('#activity-detail').children.length,0);
  assert.ok(get('#activity-action').children.some(node=>node.value==='mcp.connections'));
  assert.ok(get('#activity-action').children.some(node=>node.value==='token.create'));
  assert.ok(get('#activity-action').children.some(node=>node.value==='token.revoke'));
});
