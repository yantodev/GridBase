const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createAuth } = require("./src/github-auth");

const {
  extractDatabases,
  parseCsv,
  redactJdbcUrl,
  validateQuery,
  queryResultLimit,
} = require("./src/query-utils");

const { METADATA_LIMIT, metadataSql, extractTables, extractColumns } = require("./src/metadata");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const MAX_BODY_BYTES = 64 * 1024;
const DATABASE_LIST_SQL = "SHOW NAMESPACES IN s3tables";
function loadDotEnv(filePath = path.join(ROOT, ".env"), environment = process.env) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || !["PORT", "QUERY_TIMEOUT_MS", "DEFAULT_QUERY_LIMIT", "APP_URL", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_ALLOWED_USERS", "LEGACY_CONNECTION_OWNER_ID"].includes(match[1]) || environment[match[1]]?.trim()) continue;
    const rawValue = match[2].trim();
    const quoted = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"));
    environment[match[1]] = quoted && rawValue.length >= 2 ? rawValue.slice(1, -1) : rawValue;
  }
}

loadDotEnv();

function isExecutable(filePath) {
  try {
    return fs.statSync(filePath).isFile() && (fs.statSync(filePath).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function resolveBeelineBin(environment = process.env) {
  if (environment.BEELINE_BIN) return environment.BEELINE_BIN;

  for (const directory of (environment.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "beeline");
    if (isExecutable(candidate)) return candidate;
  }

  const sparkRoot = path.join(os.homedir(), ".local", "opt");
  const sparkCandidates = [path.join(sparkRoot, "spark", "bin", "beeline")];
  try {
    const sparkDirectories = fs.readdirSync(sparkRoot)
      .filter((name) => name.startsWith("spark-"))
      .sort()
      .reverse();
    sparkDirectories.forEach((name) => sparkCandidates.push(path.join(sparkRoot, name, "bin", "beeline")));
  } catch {
    // Fall back to PATH when the local Spark directory is not present.
  }
  return sparkCandidates.find(isExecutable) || "beeline";
}

const config = {
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || "127.0.0.1",
  beelineBin: resolveBeelineBin(),
  ...loadConnectionConfig(process.env),
  timeoutMs: Math.min(Math.max(Number(process.env.QUERY_TIMEOUT_MS || 30000), 1000), 120000),
  defaultQueryLimit: Math.min(Math.max(Number.parseInt(process.env.DEFAULT_QUERY_LIMIT, 10) || 50, 1), 10000),
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function getHealth() {
  const configured = Boolean(config.jdbcUrl && config.username && config.password.trim());
  return {
    status: configured ? "ok" : "degraded",
    configured,
    readOnly: false,
    target: redactJdbcUrl(config.jdbcUrl),
  };
}

function loadConnectionConfig(environment) {
  const connection = {
    jdbcUrl: (environment.THRIFT_JDBC_URL || "").trim(),
    username: (environment.THRIFT_USERNAME || "").trim(),
    password: environment.THRIFT_PASSWORD || "",
  };
  if (connection.jdbcUrl && connection.username && connection.password.trim()) {
    requireCredentialValue(connection.jdbcUrl, "JDBC URL", 2048);
    requireCredentialValue(connection.username, "username", 256);
    requireCredentialValue(connection.password, "password", 2048);
    if (!connection.jdbcUrl.startsWith("jdbc:hive2://")) {
      throw new Error("JDBC URL harus menggunakan jdbc:hive2://.");
    }
  }
  return connection;
}

function requireCredentialValue(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} wajib diisi.`);
  if (value.length > maxLength) throw new Error(`${label} terlalu panjang.`);
  return value;
}

function describeBeelineSpawnError(error, binary = config.beelineBin) {
  if (error?.code === "ENOENT") {
    return `Beeline executable tidak ditemukan: ${binary}. Set BEELINE_BIN ke path executable Beeline, lalu restart server.`;
  }
  if (error?.code === "EACCES") {
    return `Beeline executable tidak bisa dijalankan: ${binary}. Periksa permission executable file tersebut.`;
  }
  return "Beeline tidak bisa dijalankan. Periksa BEELINE_BIN dan PATH server.";
}

function buildBeelineArgs({ jdbcUrl, username, passwordFile }) {
  return [
    "-u", jdbcUrl,
    "-n", username,
    "-w", passwordFile,
    "--silent=true",
    "--showHeader=true",
    "--outputformat=csv2",
    "--verbose=false",
  ];
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function runBeeline(sql) {
  if (!config.jdbcUrl || !config.username || !config.password.trim()) {
    return Promise.reject(Object.assign(new Error("Database connection is not configured"), { code: "NOT_CONFIGURED" }));
  }

  return new Promise((resolve, reject) => {
    const passwordDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "thrift-query-"));
    const passwordFile = path.join(passwordDirectory, "password");
    fs.writeFileSync(passwordFile, config.password, { mode: 0o600 });
    fs.chmodSync(passwordFile, 0o600);
    const cleanupPasswordFile = () => {
      try {
        fs.rmSync(passwordDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the temporary directory is uniquely scoped.
      }
    };
    const args = buildBeelineArgs({
      jdbcUrl: config.jdbcUrl,
      username: config.username,
      passwordFile,
    });
    const child = spawn(config.beelineBin, args, {
      cwd: ROOT,
      env: { ...process.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      cleanupPasswordFile();
      const spawnError = new Error(describeBeelineSpawnError(error));
      spawnError.code = error.code === "ENOENT" ? "BEELINE_NOT_FOUND" : error.code === "EACCES" ? "BEELINE_NOT_EXECUTABLE" : "BEELINE_START_FAILED";
      spawnError.cause = error;
      reject(spawnError);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      cleanupPasswordFile();
      if (timedOut) {
        reject(Object.assign(new Error("Query timed out"), { code: "TIMEOUT" }));
        return;
      }
      if (code !== 0) {
        const error = new Error("Beeline returned an error");
        error.code = "BEELINE_FAILED";
        error.detail = stderr.slice(-1200);
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.end(`${sql};\n!quit\n`);
  });
}

async function handleQuery(request, response, execute = runBeeline) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: "Request tidak valid." });
    return;
  }

  if (body.connectionId && body.connectionId !== 'default') {
    sendJson(response, 404, { error: "Koneksi tidak ditemukan. Backend Node legacy hanya mendukung koneksi default." });
    return;
  }
  const validation = validateQuery(body.sql);
  if (!validation.ok) {
    sendJson(response, 422, { error: validation.error });
    return;
  }

  const startedAt = Date.now();
  try {
    const plan = queryResultLimit(validation.sql, config.defaultQueryLimit);
    const result = await execute(plan.sql);
    const parsed = parseCsv(result.stdout);
    const rows = plan.rowLimit === null ? parsed.rows : parsed.rows.slice(0, plan.rowLimit);
    sendJson(response, 200, {
      columns: parsed.columns,
      rows,
      rowCount: rows.length,
      durationMs: Date.now() - startedAt,
      truncated: parsed.rows.length > rows.length,
      updateCount: null,
    });
  } catch (error) {
    const statusCode = error.code === "TIMEOUT" ? 504 : ["NOT_CONFIGURED", "BEELINE_NOT_FOUND", "BEELINE_NOT_EXECUTABLE"].includes(error.code) ? 503 : 502;
    if (error.code === "BEELINE_FAILED" && error.detail) {
      console.error("Beeline query failed:", error.detail);
    } else {
      console.error("Query request failed:", error.message);
    }
    sendJson(response, statusCode, {
      error: error.code === "TIMEOUT"
        ? "Query melewati batas waktu. Coba persempit filter atau batasi jumlah baris."
        : error.code === "NOT_CONFIGURED"
          ? "Koneksi database belum dikonfigurasi di server."
          : ["BEELINE_NOT_FOUND", "BEELINE_NOT_EXECUTABLE"].includes(error.code)
            ? error.message
          : "Query gagal dijalankan. Periksa koneksi dan kredensial Beeline.",
    });
  }
}

async function handleDatabaseList(response, responseField, label) {
  try {
    const result = await runBeeline(DATABASE_LIST_SQL);
    const parsed = parseCsv(result.stdout);
    sendJson(response, 200, {
      [responseField]: extractDatabases(parsed).slice(0, METADATA_LIMIT),
    });
  } catch (error) {
    if (error.code === "BEELINE_FAILED" && error.detail) {
      console.error(`${label} query failed:`, error.detail);
    } else {
      console.error(`${label} request failed:`, error.message);
    }
    const statusCode = error.code === "TIMEOUT" ? 504 : ["NOT_CONFIGURED", "BEELINE_NOT_FOUND", "BEELINE_NOT_EXECUTABLE"].includes(error.code) ? 503 : 502;
    sendJson(response, statusCode, {
      error: `${label} tidak dapat dimuat. Periksa koneksi dan kredensial Beeline.`,
    });
  }
}

async function handleDatabases(response) {
  return handleDatabaseList(response, "databases", "Database");
}

async function handleNamespaces(response) {
  return handleDatabaseList(response, "namespaces", "Namespace");
}

async function handleMetadata(response, url, execute = runBeeline) {
  let sql;
  const columns = url.pathname === "/api/columns";
  try {
    sql = metadataSql(url.searchParams.get("namespace"), columns ? url.searchParams.get("table") : undefined);
  } catch (error) {
    sendJson(response, 422, { error: error.message });
    return;
  }
  try {
    const result = await execute(sql);
    const parsed = parseCsv(result.stdout);
    sendJson(response, 200, columns ? { columns: extractColumns(parsed) } : { tables: extractTables(parsed) });
  } catch (error) {
    const status = error.code === "TIMEOUT" ? 504 : ["NOT_CONFIGURED", "BEELINE_NOT_FOUND", "BEELINE_NOT_EXECUTABLE"].includes(error.code) ? 503 : 502;
    sendJson(response, status, { error: "Metadata tidak dapat dimuat. Periksa koneksi lalu refresh." });
  }
}

function serveStatic(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    sendJson(response, 400, { error: "Path tidak valid." });
    return;
  }
  const relativePath = pathname === "/" ? "/index.html" : pathname === "/login" ? "/login.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${relativePath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendJson(response, 403, { error: "Akses ditolak." });
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: "Halaman tidak ditemukan." });
      return;
    }
    response.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  });
}

function createServer(options = {}) {
  const environment = options.environment || process.env;
  const legacyOwner = (environment.LEGACY_CONNECTION_OWNER_ID || '').trim();
  if (legacyOwner && !/^[1-9][0-9]{0,19}$/.test(legacyOwner)) throw new Error('Invalid legacy owner ID');
  const auth = createAuth(environment, {sendJson, securityHeaders, identify: options.identify, now: options.now});
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (await auth(request, response, url)) return;
    if (url.pathname === '/api/activity' || url.pathname.startsWith('/api/activity/')) {
      sendJson(response, 501, {error: 'Audit aktivitas membutuhkan backend Java JDBC. Jalankan npm start.'}); return;
    }
    const ownsConnection = Boolean(legacyOwner && request.user?.id === legacyOwner);
    const privateHealth = ownsConnection ? getHealth() : {status: 'degraded', configured: false, readOnly: false, target: null};
    if (request.method === "GET" && url.pathname === "/api/connections") {
      const health = privateHealth;
      sendJson(response, 200, { defaultConnectionId: health.configured ? "default" : null,
        connections: health.configured ? [{ id: "default", name: "Spark Thrift / Hive", type: "hive" }] : [] });
      return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/connections/")) {
      sendJson(response, 501, { error: "Multi koneksi membutuhkan backend Java JDBC. Jalankan npm start." });
      return;
    }
    const databasePaths = ['/api/query', '/api/databases', '/api/namespaces', '/api/tables', '/api/columns'];
    if (!ownsConnection && databasePaths.includes(url.pathname)) {
      let explicit = url.searchParams.get('connectionId');
      if (url.pathname === '/api/query' && request.method === 'POST') {
        try { explicit = (await readJsonBody(request)).connectionId; }
        catch (error) { sendJson(response, error.statusCode || 400, {error: 'Request tidak valid.'}); return; }
      }
      sendJson(response, explicit ? 404 : 503, {error: explicit ? 'Koneksi tidak ditemukan.' : 'Koneksi database belum dikonfigurasi untuk akun ini.'}); return;
    }
    if (request.method === "GET" && ["/api/databases", "/api/namespaces", "/api/tables", "/api/columns"].includes(url.pathname)
        && url.searchParams.get("connectionId") && url.searchParams.get("connectionId") !== "default") {
      sendJson(response, 404, { error: "Koneksi tidak ditemukan." }); return;
    }
    if (request.method === "GET" && ["/api/tables", "/api/columns"].includes(url.pathname)) {
      await handleMetadata(response, url);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, privateHealth);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/query") {
      await handleQuery(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/databases") {
      await handleDatabases(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/namespaces") {
      await handleNamespaces(response);
      return;
    }
    if (request.method === "GET") {
      serveStatic(request, response);
      return;
    }
    sendJson(response, 405, { error: "Method tidak didukung." });
  });
}

if (require.main === module && process.argv.includes("--legacy")) {
  createServer().listen(config.port, config.host, () => {
    console.log(`GridBase running at http://${config.host}:${config.port}`);
    console.log(`Beeline executable: ${config.beelineBin}`);
  });
} else if (require.main === module) {
  console.error("Node backend legacy tidak dijalankan. Gunakan `npm start` untuk backend Java JDBC.");
  process.exitCode = 1;
}

module.exports = {
  config,
  createServer,
  DATABASE_LIST_SQL,
  buildBeelineArgs,
  describeBeelineSpawnError,
  getHealth,
  handleQuery,
  handleDatabases,
  handleNamespaces,
  handleMetadata,
  loadConnectionConfig,
  loadDotEnv,
  parseCsv,
  readJsonBody,
  resolveBeelineBin,
  runBeeline,
};

