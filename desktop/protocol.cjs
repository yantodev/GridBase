'use strict';
const fs = require('node:fs/promises'); const path = require('node:path');
const privilegedScheme = Object.freeze({ scheme: 'gridbase', privileges: Object.freeze({ standard: true, secure: true }) });
const ASSETS = Object.freeze({
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'], '/startup.html': ['desktop/startup.html', 'text/html; charset=utf-8'],
  '/startup.js': ['desktop/startup.js', 'text/javascript; charset=utf-8'], '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/workbench-core.js': ['public/workbench-core.js', 'text/javascript; charset=utf-8'], '/activity.js': ['public/activity.js', 'text/javascript; charset=utf-8'],
  '/mcp.js': ['public/mcp.js', 'text/javascript; charset=utf-8'], '/local-session.js': ['public/local-session.js', 'text/javascript; charset=utf-8'],
  '/runtime-transport.js': ['public/runtime-transport.js', 'text/javascript; charset=utf-8'], '/app.js': ['public/app.js', 'text/javascript; charset=utf-8']
});
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";
function assetPath(url) {
  // Check original spelling before URL normalization erases traversal segments.
  if (typeof url !== 'string' || !/^gridbase:\/\/app\/[a-z-]+\.(?:html|js|css)$/.test(url)) return null;
  const pathname = url.slice('gridbase://app'.length);
  return Object.hasOwn(ASSETS, pathname) ? pathname : null;
}
function createProtocolHandler(appRoot) {
  return async request => {
    const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers });
    const pathname = assetPath(request.url); if (!pathname) return new Response('Not found', { status: 404, headers });
    try {
      const [file, mime] = ASSETS[pathname]; let bytes = await fs.readFile(path.join(appRoot, file));
      if (pathname === '/index.html') {
        const html = bytes.toString('utf8'), marker = '<script src="/session.js" defer></script>';
        if (html.split(marker).length !== 2) throw Error();
        bytes = Buffer.from(html.replace(marker, '<script src="/runtime-transport.js" defer></script>\n  <script src="/local-session.js" defer></script>'));
      }
      return new Response(bytes, { status: 200, headers: { ...headers, 'Content-Type': mime } });
    } catch { return new Response('Packaged asset unavailable', { status: 404, headers }); }
  };
}
module.exports = { createProtocolHandler, privilegedScheme, assetPath };
