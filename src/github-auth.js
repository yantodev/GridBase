const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const SESSION_SECONDS = 8 * 60 * 60;
const STATE_SECONDS = 10 * 60;
const token = () => randomBytes(32).toString('base64url');
const challenge = verifier => createHash('sha256').update(verifier).digest('base64url');

function authConfig(environment) {
  const url = new URL(environment.APP_URL || `http://127.0.0.1:${environment.PORT || 4173}`);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !(url.protocol === 'https:' || url.protocol === 'http:' && local)) {
    throw new Error('APP_URL harus berupa origin HTTPS, atau HTTP localhost untuk pengembangan.');
  }
  return {appUrl: url.origin, clientId: (environment.GITHUB_CLIENT_ID || '').trim(),
    clientSecret: (environment.GITHUB_CLIENT_SECRET || '').trim(), secure: url.protocol === 'https:',
    allowedUsers: new Set((environment.GITHUB_ALLOWED_USERS || '').split(',').map(user => user.trim().toLowerCase()).filter(Boolean))};
}

async function githubIdentity(code, verifier, config) {
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: {'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({client_id: config.clientId, client_secret: config.clientSecret, code,
      redirect_uri: config.appUrl + '/auth/github/callback', code_verifier: verifier}),
  });
  if (!tokenResponse.ok) throw new Error('GitHub token exchange failed');
  const {access_token: accessToken} = await tokenResponse.json();
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('Missing GitHub access token');
  const identity = await fetch('https://api.github.com/user', {redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: {'Accept': 'application/vnd.github+json', 'User-Agent': 'GridBase', 'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'Bearer ' + accessToken}});
  if (!identity.ok) throw new Error('GitHub identity request failed');
  return (await identity.json()).login;
}

function createAuth(environment, {sendJson, securityHeaders, identify = githubIdentity, now = Date.now}) {
  const config = authConfig(environment);
  const configured = Boolean(config.clientId && config.clientSecret);
  const pending = new Map(), sessions = new Map();
  const publicFiles = new Set(['/login', '/login.html', '/login.js', '/styles.css']);
  function cookie(request, name) {
    for (const pair of (request.headers.cookie || '').split(';')) {
      const index = pair.indexOf('=');
      if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
    }
    return '';
  }
  function setCookie(response, name, value, path, maxAge) {
    const previous = response.getHeader('Set-Cookie') || [];
    response.setHeader('Set-Cookie', [...previous, `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${config.secure ? '; Secure' : ''}`]);
  }
  function redirect(response, location) {
    response.writeHead(303, {...securityHeaders(), 'Cache-Control': 'no-store', 'Location': location}); response.end();
  }
  function methodNotAllowed(response, allow) {
    response.setHeader('Allow', allow); sendJson(response, 405, {error: 'Method tidak didukung.'}); return true;
  }
  return async function handle(request, response, url) {
    const time = now();
    for (const [key, value] of pending) if (value.expiresAt <= time) pending.delete(key);
    for (const [key, value] of sessions) if (value.expiresAt <= time) sessions.delete(key);
    const path = url.pathname, method = request.method;
    const session = sessions.get(cookie(request, 'gridbase_session'));
    if (path === '/healthz' && method === 'GET') { sendJson(response, 200, {status: 'ok'}); return true; }
    if (path === '/auth/github') {
      if (method !== 'GET') return methodNotAllowed(response, 'GET');
      if (session) { redirect(response, '/'); return true; }
      if (!configured) { redirect(response, '/login?error=not_configured'); return true; }
      if (pending.size >= 1000) { redirect(response, '/login?error=busy'); return true; }
      const state = token(), verifier = token();
      pending.set(state, {verifier, expiresAt: time + STATE_SECONDS * 1000});
      setCookie(response, 'gridbase_oauth', state, '/auth/github', STATE_SECONDS);
      const params = new URLSearchParams({client_id: config.clientId, redirect_uri: config.appUrl + '/auth/github/callback',
        state, code_challenge: challenge(verifier), code_challenge_method: 'S256'});
      redirect(response, 'https://github.com/login/oauth/authorize?' + params); return true;
    }
    if (path === '/auth/github/callback') {
      if (method !== 'GET') return methodNotAllowed(response, 'GET');
      setCookie(response, 'gridbase_oauth', '', '/auth/github', 0);
      const state = url.searchParams.get('state') || '', browserState = cookie(request, 'gridbase_oauth');
      const a = Buffer.from(state), b = Buffer.from(browserState);
      const duplicate = [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1);
      if (duplicate || !state || a.length !== b.length || !timingSafeEqual(a, b)) {
        redirect(response, '/login?error=invalid_state'); return true;
      }
      const attempt = pending.get(state); pending.delete(state);
      if (!attempt) { redirect(response, '/login?error=invalid_state'); return true; }
      if (url.searchParams.has('error')) { redirect(response, '/login?error=denied'); return true; }
      const code = url.searchParams.get('code') || '';
      if (!configured || !code.trim() || code.length > 2048) { redirect(response, '/login?error=failed'); return true; }
      try {
        const login = await identify(code, attempt.verifier, config);
        if (typeof login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error('Invalid GitHub login');
        if (config.allowedUsers.size && !config.allowedUsers.has(login.toLowerCase())) {
          redirect(response, '/login?error=not_allowed'); return true;
        }
        if (sessions.size >= 10000) { redirect(response, '/login?error=busy'); return true; }
        sessions.delete(cookie(request, 'gridbase_session'));
        const sessionToken = token();
        sessions.set(sessionToken, {login, expiresAt: now() + SESSION_SECONDS * 1000});
        setCookie(response, 'gridbase_session', sessionToken, '/', SESSION_SECONDS);
        redirect(response, '/');
      } catch { redirect(response, '/login?error=failed'); }
      return true;
    }
    if (path === '/api/auth/session') {
      if (method !== 'GET') return methodNotAllowed(response, 'GET');
      sendJson(response, 200, {authenticated: Boolean(session), configured, user: session ? {login: session.login} : null}); return true;
    }
    if (publicFiles.has(path) && method === 'GET') {
      if (session && ['/login', '/login.html'].includes(path)) { redirect(response, '/'); return true; }
      return false;
    }
    if (!session) {
      if (path.startsWith('/api/') || path === '/auth/logout') sendJson(response, 401, {error: 'Silakan login dengan GitHub.'});
      else redirect(response, '/login');
      return true;
    }
    if (!['GET', 'HEAD'].includes(method)) {
      const origin = request.headers.origin, type = request.headers['content-type'];
      if (origin && origin !== config.appUrl || request.headers['sec-fetch-site'] === 'cross-site'
          || method === 'POST' && type?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        sendJson(response, 403, {error: 'Asal request tidak diizinkan.'}); return true;
      }
    }
    if (path === '/auth/logout') {
      if (method !== 'POST') return methodNotAllowed(response, 'POST');
      sessions.delete(cookie(request, 'gridbase_session'));
      setCookie(response, 'gridbase_session', '', '/', 0);
      sendJson(response, 200, {ok: true}); return true;
    }
    return false;
  };
}

module.exports = {createAuth, authConfig};
