'use strict';
const { failure } = require('./errors');
const MAX_REQUEST = 64 * 1024;
const MAX_RESPONSE = 16 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function invalid() { throw failure('INVALID_REQUEST'); }
// Scan the original JSON before JSON.parse: decoded duplicate keys, depth and
// token counts are bounded, including escaped aliases and nested objects.
function strictJson(text, max = MAX_REQUEST) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > max) invalid();
  let i = 0, tokens = 0;
  const ws = () => { while (/[ \t\r\n]/.test(text[i] || '\0')) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') return JSON.parse(text.slice(start, i));
      if (c === '\\') i++;
    }
    invalid();
  }
  function value(depth) {
    if (++tokens > 100000 || depth > 32) invalid();
    ws(); const c = text[i];
    if (c === '"') { string(); return; }
    if (c === '{' || c === '[') {
      i++; ws(); const end = c === '{' ? '}' : ']';
      const keys = new Set();
      if (text[i] === end) { i++; return; }
      while (i < text.length) {
        if (c === '{') {
          ws(); if (text[i] !== '"') invalid();
          const key = string(); if (keys.has(key)) invalid(); keys.add(key);
          ws(); if (text[i++] !== ':') invalid();
        }
        value(depth + 1); ws();
        if (text[i] === end) { i++; return; }
        if (text[i++] !== ',') invalid();
      }
      invalid();
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if (!match) invalid(); i += match[0].length;
  }
  try { value(0); ws(); if (i !== text.length) invalid(); return JSON.parse(text); }
  catch { invalid(); }
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function plainJson(value, depth = 0) {
  if (depth > 32) invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) invalid();
    plainJson(d.value, depth + 1);
  }
}
function keys(value, allowed, required = []) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) invalid();
}
function text(value, max, nonempty = true) {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()) || /[\x00-\x1f\x7f]/.test(value)) invalid();
}
const ACTIONS = new Set(['auth.start','auth.login','auth.logout','connection.list','connection.save','connection.test','connection.connect','connection.details','connection.disconnect','connection.delete','query.execute','metadata.databases','metadata.namespaces','metadata.tables','metadata.columns','result.export_requested','mcp.connections','token.create','token.revoke']);
function activity(params) {
  for (const [key, value] of params) {
    if (key === 'scope' && value !== 'mine') invalid();
    if (key === 'connectionId' && !ID.test(value)) invalid();
    if (key === 'action' && !ACTIONS.has(value)) invalid();
    if (key === 'outcome' && !['pending','success','failure','denied'].includes(value)) invalid();
    if (['cursor','limit'].includes(key) && (!/^[1-9][0-9]*$/.test(value) || BigInt(value) > (key === 'limit' ? 100n : 9223372036854775807n))) invalid();
    if (['from','to'].includes(key) && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value)))) invalid();
  }
  if (params.has('from') && params.has('to') && Date.parse(params.get('from')) > Date.parse(params.get('to'))) invalid();
}
function validateRequest(input) {
  try {
    keys(input, ['method', 'path', 'body', 'signal'], ['method', 'path']);
    const { method, path, signal } = input;
    if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
    if (typeof path !== 'string' || Buffer.byteLength(path) > MAX_REQUEST || /[\x00-\x20\x7f\\#]/.test(path) || !path.startsWith('/') || path.startsWith('//')) invalid();
    const q = path.indexOf('?'), route = q < 0 ? path : path.slice(0, q);
    // Routes never contain encoded components. Query identifiers remain encoded
    // data, not path segments (e.g. namespace=a%2Fb is a valid identifier).
    if (route.includes('%') || route.includes('@') || route.includes(':')) invalid();
    let methods, query = [], schema;
    if (['/healthz','/api/auth/session','/api/health','/api/connections'].includes(route)) methods = route === '/api/connections' ? ['GET','POST'] : ['GET'];
    else if ((method === 'POST' && ['/api/connections/test','/api/connections/connect','/api/connections/disconnect'].includes(route)) || ['/api/query','/api/activity/exports'].includes(route)) methods = ['POST'];
    else if (/^\/api\/connections\/[A-Za-z0-9_-]{1,100}$/.test(route)) methods = ['GET','DELETE'];
    else if (['/api/databases','/api/namespaces','/api/tables','/api/columns'].includes(route)) {
      methods = ['GET']; query = ['connectionId', ...(['/api/tables','/api/columns'].includes(route) ? ['namespace'] : []), ...(route === '/api/columns' ? ['table'] : [])];
    } else if (route === '/api/activity') { methods = ['GET']; query = ['scope','from','to','action','outcome','connectionId','cursor','limit']; }
    else if (route === '/api/mcp/tokens') methods = ['GET','POST'];
    else if (route.startsWith('/api/mcp/tokens/') && UUID.test(route.slice(16))) methods = ['DELETE'];
    else if (route === '/api/local/mcp') methods = ['GET','PUT'];
    else invalid();
    if (!methods.includes(method)) invalid();
    const rawQuery = q < 0 ? '' : path.slice(q + 1);
    if (/%(?![0-9a-fA-F]{2})/.test(rawQuery)) invalid();
    // Force strict UTF-8 decode rather than URLSearchParams replacement decoding.
    decodeURIComponent(rawQuery.replaceAll('+', ' '));
    const params = new URLSearchParams(rawQuery), seen = new Set();
    for (const [key, value] of params) {
      if (seen.has(key) || !query.includes(key) || /[\x00-\x1f\x7f]/.test(value) || value.length > 2048) invalid();
      seen.add(key); if (key === 'connectionId' && !ID.test(value)) invalid();
    }
    if (route === '/api/activity') activity(params);
    const hasBody = Object.hasOwn(input, 'body');
    if (!['POST','PUT'].includes(method)) { if (hasBody) invalid(); return { method, path, signal, body: undefined }; }
    if (!hasBody) invalid();
    if (typeof input.body !== 'string') plainJson(input.body);
    const serialized = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
    const body = strictJson(serialized);
    if (Buffer.byteLength(path) + Buffer.byteLength(serialized) > MAX_REQUEST) invalid();
    if (route === '/api/query') {
      schema = ['sql','connectionId']; keys(body, schema, ['sql']);
      if (typeof body.sql !== 'string' || !body.sql.trim() || body.sql.length > 20000 || body.sql.includes('\0')) invalid();
    } else if (route === '/api/connections/disconnect') { keys(body, ['connectionId'], ['connectionId']); }
    else if (route.startsWith('/api/connections')) {
      keys(body, ['connectionId','type','name','jdbcUrl','username','password','host','port','database','ssl','mcpReadOnly'], ['type']);
      if (!['postgresql','mysql','hive'].includes(body.type)) invalid();
      const bounds = { name: 80, jdbcUrl: 2048, username: 256, password: 2048, host: 256, port: 5, database: 256 };
      for (const [key, max] of Object.entries(bounds)) if (Object.hasOwn(body, key)) text(body[key], max, false);
      for (const key of ['ssl','mcpReadOnly']) if (Object.hasOwn(body, key) && typeof body[key] !== 'boolean') invalid();
      if (Object.hasOwn(body, 'port') && body.port !== '' && (!/^[0-9]{1,5}$/.test(body.port) || +body.port < 1 || +body.port > 65535)) invalid();
    } else if (route === '/api/local/mcp') {
      keys(body, ['enabled','port'], ['enabled','port']);
      if (typeof body.enabled !== 'boolean' || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) invalid();
    } else if (route === '/api/activity/exports') {
      keys(body, ['queryRequestId','format','rowCount'], ['queryRequestId','format','rowCount']);
      if (!UUID.test(body.queryRequestId) || !['csv','json'].includes(body.format) || !Number.isSafeInteger(body.rowCount) || body.rowCount < 0) invalid();
    } else if (route === '/api/mcp/tokens') {
      keys(body, ['name','scope','expiresInDays','connectionIds'], ['name','scope','expiresInDays','connectionIds']); text(body.name, 80);
      if (!['read_only','full_access'].includes(body.scope) || ![30,90,365].includes(body.expiresInDays) || !Array.isArray(body.connectionIds) || body.connectionIds.length < 1 || body.connectionIds.length > 20 || body.connectionIds.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(body.connectionIds).size !== body.connectionIds.length) invalid();
    } else invalid();
    if (Object.hasOwn(body, 'connectionId') && (typeof body.connectionId !== 'string' || !ID.test(body.connectionId))) invalid();
    return { method, path, signal, body: serialized };
  } catch { invalid(); }
}
module.exports = { validateRequest, strictJson, MAX_REQUEST, MAX_RESPONSE, UUID };
