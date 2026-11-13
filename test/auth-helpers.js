const assert = require('node:assert/strict');

async function beginLogin(base) {
  const response = await fetch(base + '/auth/github', {redirect: 'manual'});
  assert.equal(response.status, 303);
  const authorization = new URL(response.headers.get('location'));
  assert.equal(authorization.origin, 'https://github.com');
  return {state: authorization.searchParams.get('state'), challenge: authorization.searchParams.get('code_challenge'),
    cookie: response.headers.get('set-cookie').split(';')[0], authorization};
}

async function completeLogin(base, flow, code = 'fixture') {
  return fetch(base + '/auth/github/callback?' + new URLSearchParams({state: flow.state, code}), {
    redirect: 'manual', headers: {Cookie: flow.cookie},
  });
}

async function login(base) {
  const response = await completeLogin(base, await beginLogin(base));
  assert.equal(response.headers.get('location'), '/');
  return response.headers.get('set-cookie').match(/gridbase_session=[^;,]+/)[0];
}

module.exports = {beginLogin, completeLogin, login};
