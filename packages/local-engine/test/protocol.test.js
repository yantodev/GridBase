'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('broker accepts the existing query contract and serializes JSON', () => {
  const { validateRequest } = require('../protocol');
  const result = validateRequest({ method: 'POST', path: '/api/query', body: { sql: 'SELECT 1', connectionId: 'fixture' } });
  assert.equal(result.path, '/api/query');
  assert.equal(result.body, '{"sql":"SELECT 1","connectionId":"fixture"}');
});
test('broker rejects transport escape, forged headers, unknown fields and bounds', () => {
  const { validateRequest, strictJson } = require('../protocol');
  const bad = [
    { path: 'http://user@127.0.0.1/healthz' }, { path: '//host/healthz' },
    ...['/api/%2e%2e/query', '/api/connections/%252f', '/healthz#x', '/healthz\\x', '/api/activity/users', '/mcp', '/auth/logout'].map(path => ({ path })),
    { path: '/healthz', headers: { Authorization: 'secret' } },
    { path: '/healthz', method: 'TRACE' }, { path: '/healthz?x=1' },
    { path: '/api/tables?connectionId=x&connectionId=y' }, { path: '/api/activity?scope=all' },
    { method: 'POST', path: '/api/query', body: { sql: 'x', extra: true } },
    { method: 'POST', path: '/api/query', body: { sql: 'x'.repeat(20001) } },
    { method: 'POST', path: '/api/query', body: '{"sql":"a","sql":"b"}' },
    { method: 'POST', path: '/api/connections', body: { password: '界'.repeat(30000) } },
    { method: 'PUT', path: '/api/local/mcp', body: { enabled: true, port: 0 } }
  ];
  for (const value of bad) assert.throws(() => validateRequest({ method: 'GET', ...value }), { code: 'INVALID_REQUEST' });
  assert.throws(() => strictJson('{"a":1,"\\u0061":2}'));
  assert.throws(() => strictJson('['.repeat(50) + '0' + ']'.repeat(50)));
});
test('route schemas match existing HTTP operations without restricting metadata identifiers', () => {
  const { validateRequest } = require('../protocol');
  const cases = [
    ['GET', '/api/tables?connectionId=x&namespace=a%2Fb%25%20%22'],
    ['GET', '/api/columns?table=a%2Fb&namespace=x'], ['GET', '/api/activity?scope=mine&limit=100&outcome=success'],
    ['DELETE', '/api/connections/abc_-1'], ['GET', '/api/mcp/tokens'],
    ['POST', '/api/mcp/tokens', { name: 'test', scope: 'full_access', expiresInDays: 30, connectionIds: ['x'] }],
    ['PUT', '/api/local/mcp', { enabled: false, port: 5000 }],
    ['POST', '/api/connections', { type: 'postgresql', host: 'localhost', port: '5432', database: 'fixture', username: 'u', password: 'p', mcpReadOnly: true }],
    ['POST', '/api/connections', { type: 'hive', host: '', port: '', database: '', jdbcUrl: 'jdbc:hive2://localhost:10000/default', username: 'u', password: 'p' }],
    ['POST', '/api/connections/disconnect', { connectionId: 'x' }],
    ['POST', '/api/activity/exports', { queryRequestId: '12345678-1234-1234-1234-123456789abc', format: 'json', rowCount: 0 }]
  ];
  for (const [method, path, body] of cases) assert.equal(validateRequest({ method, path, ...(body ? { body } : {}) }).path, path);
});
test('broker rejects unknown unserializable fields instead of dropping them', () => {
  const { validateRequest } = require('../protocol');
  for (const body of [{ sql: 'SELECT 1', evil: undefined }, { sql: 'SELECT 1', toJSON: () => ({ sql: 'SELECT 1' }) }, { sql: 'SELECT 1', evil: Symbol('x') }])
    assert.throws(() => validateRequest({ method: 'POST', path: '/api/query', body }), { code: 'INVALID_REQUEST' });
  assert.equal(validateRequest({ method: 'DELETE', path: '/api/mcp/tokens/12345678-1234-1234-1234-123456789abc' }).method, 'DELETE');
});
test('I2 action-looking connection IDs preserve GET/DELETE without widening verbs or bodies', () => {
  const { validateRequest } = require('../protocol');
  for (const id of ['test','connect','disconnect']) {
    const path = '/api/connections/' + id;
    for (const method of ['GET','DELETE']) {
      assert.equal(validateRequest({ method, path }).method, method);
      assert.throws(() => validateRequest({ method, path, body: { connectionId: id } }), { code: 'INVALID_REQUEST' });
    }
    for (const method of ['PUT','PATCH','HEAD','OPTIONS']) assert.throws(() => validateRequest({ method, path, body: {} }), { code: 'INVALID_REQUEST' });
    const body = id === 'disconnect' ? { connectionId: id } : { connectionId: id, type: 'postgresql', jdbcUrl: 'jdbc:postgresql://localhost/fixture', username: 'u', password: 'p' };
    assert.equal(validateRequest({ method: 'POST', path, body }).body, JSON.stringify(body));
    assert.throws(() => validateRequest({ method: 'POST', path, body: { ...body, unknown: true } }), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => validateRequest({ method: 'POST', path: '/api/connections/ordinary-id', body: { connectionId: 'ordinary-id' } }), { code: 'INVALID_REQUEST' });
});
