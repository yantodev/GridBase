const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {createServer} = require('../server');
const {authConfig} = require('../src/github-auth');
const {beginLogin, completeLogin, login} = require('./auth-helpers');

const environment = {APP_URL: 'http://127.0.0.1:4173', GITHUB_CLIENT_ID: 'fixture-id', GITHUB_CLIENT_SECRET: 'fixture-secret', GITHUB_ALLOWED_USERS: 'Fixture-User'};
async function withServer(options, run) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const request = (base, path, cookie = '', options = {}) => fetch(base + path, {
  redirect: 'manual', ...options, headers: {Cookie: cookie, ...options.headers},
});

test('legacy server requires GitHub login for workbench and every database API even without credentials', async () => {
  await withServer({environment: {}}, async base => {
    for (const path of ['/', '/index.html', '/%69ndex.html', '/app.js', '/workbench-core.js']) {
      const response = await request(base, path);
      assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/login');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await request(base, '/login')).status, 200);
    for (const path of ['/api/health', '/api/query', '/api/connections', '/api/connections/private', '/api/databases', '/api/namespaces', '/api/tables', '/api/columns']) {
      assert.equal((await request(base, path)).status, 401);
      assert.equal((await request(base, path, '', {method: 'POST'})).status, 401);
    }
    assert.deepEqual(await (await request(base, '/api/auth/session')).json(), {authenticated: false, configured: false, user: null});
    assert.equal((await request(base, '/auth/github')).headers.get('location'), '/login?error=not_configured');
    assert.deepEqual(await (await request(base, '/healthz')).json(), {status: 'ok'});
  });
});

test('OAuth binds browser state and PKCE, rejects replay, protects mutations and revokes logout sessions', async () => {
  let expectedChallenge, calls = 0;
  await withServer({environment, identify: async (code, verifier) => {
    calls++;
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), expectedChallenge);
    assert.equal(code, 'fixture'); return 'fixture-user';
  }}, async base => {
    const flow = await beginLogin(base); expectedChallenge = flow.challenge;
    assert.equal(flow.authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(flow.authorization.searchParams.get('redirect_uri'), environment.APP_URL + '/auth/github/callback');
    assert.equal(flow.authorization.searchParams.has('client_secret'), false);
    assert.equal((await request(base, '/auth/github/callback?state=' + flow.state + '&code=fixture')).headers.get('location'), '/login?error=invalid_state');
    assert.equal((await completeLogin(base, {...flow, state: 'wrong'})).headers.get('location'), '/login?error=invalid_state');
    assert.equal(calls, 0);
    const response = await completeLogin(base, flow);
    const cookies = response.headers.get('set-cookie');
    assert.match(cookies, /HttpOnly/); assert.match(cookies, /SameSite=Lax/); assert.match(cookies, /Max-Age=28800/);
    const cookie = cookies.match(/gridbase_session=[^;,]+/)[0];
    assert.equal((await request(base, '/', cookie)).status, 200);
    assert.deepEqual(await (await request(base, '/api/auth/session', cookie)).json(), {authenticated: true, configured: true, user: {login: 'fixture-user'}});
    assert.equal((await request(base, '/login', cookie)).headers.get('location'), '/');
    assert.equal((await completeLogin(base, flow)).headers.get('location'), '/login?error=invalid_state');
    assert.equal(calls, 1);
    const post = {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'};
    assert.equal((await request(base, '/auth/logout', cookie, {...post, headers: {...post.headers, Origin: 'https://evil.example'}})).status, 403);
    assert.equal((await request(base, '/api/query', cookie, {method: 'POST', body: '{}'})).status, 403);
    assert.equal((await request(base, '/api/connections', cookie)).status, 200);
    assert.equal((await request(base, '/auth/logout', cookie)).status, 405);
    const logout = await request(base, '/auth/logout', cookie, post);
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request(base, '/api/connections', cookie)).status, 401);
    assert.equal((await request(base, '/api/connections', 'gridbase_session=forged')).status, 401);
  });
});

test('denied, failed, unapproved, duplicate and expired callbacks cannot create sessions', async () => {
  let time = 1_000_000;
  await withServer({environment, now: () => time, identify: async code => {
    if (code === 'failure') throw new Error('fixture');
    return code === 'outsider' ? 'outsider' : 'fixture-user';
  }}, async base => {
    for (const [code, error] of [['failure', 'failed'], ['outsider', 'not_allowed'], ['', 'failed']]) {
      const response = await completeLogin(base, await beginLogin(base), code);
      assert.equal(response.headers.get('location'), '/login?error=' + error);
      assert.doesNotMatch(response.headers.get('set-cookie'), /gridbase_session=/);
    }
    const denied = await beginLogin(base);
    assert.equal((await request(base, '/auth/github/callback?state=' + denied.state + '&error=access_denied', denied.cookie)).headers.get('location'), '/login?error=denied');
    const duplicate = await beginLogin(base);
    assert.equal((await request(base, '/auth/github/callback?state=' + duplicate.state + '&state=bad&code=fixture', duplicate.cookie)).headers.get('location'), '/login?error=invalid_state');
    const expired = await beginLogin(base); time += 600_000;
    assert.equal((await completeLogin(base, expired)).headers.get('location'), '/login?error=invalid_state');
    const cookie = await login(base); time += 28_800_000;
    assert.equal((await request(base, '/api/connections', cookie)).status, 401);
  });
});

test('production origin validation and Secure cookies', async () => {
  for (const APP_URL of ['http://gridbase.example', 'https://gridbase.example/path', 'https://user:password@gridbase.example', 'https://gridbase.example?evil']) {
    assert.throws(() => authConfig({APP_URL}));
  }
  await withServer({environment: {...environment, APP_URL: 'https://gridbase.example'}, identify: async () => 'fixture-user'}, async base => {
    const flow = await beginLogin(base);
    const response = await completeLogin(base, flow);
    assert.match(response.headers.get('set-cookie'), /gridbase_session=[^,]+; Secure/);
  });
});
