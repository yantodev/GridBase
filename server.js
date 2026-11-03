const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  parseCsv,
  redactJdbcUrl,
  validateQuery,
} = require("./src/query-utils");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const MAX_BODY_BYTES = 64 * 1024;

function loadDotEnv(filePath = path.join(ROOT, ".env")) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].replace(/^['"]|['"]$/g, "");
    process.env[match[1]] = value;
  }
}

loadDotEnv();

const config = {
  port: Number(process.env.PORT || 4173),
  host: process.env.HOST || "127.0.0.1",
  beelineBin: process.env.BEELINE_BIN || "beeline",
  jdbcUrl: process.env.THRIFT_JDBC_URL || "",
  username: process.env.THRIFT_USERNAME || "",
  password: process.env.THRIFT_PASSWORD || "",
  timeoutMs: Math.min(Math.max(Number(process.env.QUERY_TIMEOUT_MS || 30000), 1000), 120000),
  maxRows: Math.min(Math.max(Number(process.env.MAX_QUERY_ROWS || 1000), 1), 10000),
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
  return {
    status: config.jdbcUrl && config.username && config.password ? "ok" : "degraded",
    configured: Boolean(config.jdbcUrl && config.username && config.password),
    readOnly: true,
    target: redactJdbcUrl(config.jdbcUrl),
  };
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
  if (!config.jdbcUrl || !config.username || !config.password) {
    return Promise.reject(Object.assign(new Error("Database connection is not configured"), { code: "NOT_CONFIGURED" }));
  }

  return new Promise((resolve, reject) => {
    const args = [
      "-u", config.jdbcUrl,
      "-n", config.username,
      "-p", config.password,
      "--silent=true",
      "--showHeader=true",
      "--outputformat=csv2",
      "--verbose=false",
    ];
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
      reject(Object.assign(new Error("Beeline could not be started"), { cause: error }));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
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

async function handleQuery(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: "Request tidak valid." });
    return;
  }

  const validation = validateQuery(body.sql);
  if (!validation.ok) {
    sendJson(response, 422, { error: validation.error });
    return;
  }

  const startedAt = Date.now();
  try {
    const result = await runBeeline(validation.sql);
    const parsed = parseCsv(result.stdout);
    const rows = parsed.rows.slice(0, config.maxRows);
    sendJson(response, 200, {
      columns: parsed.columns,
      rows,
      rowCount: rows.length,
      durationMs: Date.now() - startedAt,
      truncated: parsed.rows.length > rows.length,
    });
  } catch (error) {
    const statusCode = error.code === "TIMEOUT" ? 504 : error.code === "NOT_CONFIGURED" ? 503 : 502;
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
          : "Query gagal dijalankan. Periksa koneksi dan kredensial Beeline.",
    });
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
  const relativePath = pathname === "/" ? "/index.html" : pathname;
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
      "Cache-Control": "no-cache",
    });
    response.end(content);
  });
}

function createServer() {
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/health")) {
      sendJson(response, 200, getHealth());
      return;
    }
    if (request.method === "POST" && request.url === "/api/query") {
      await handleQuery(request, response);
      return;
    }
    if (request.method === "GET") {
      serveStatic(request, response);
      return;
    }
    sendJson(response, 405, { error: "Method tidak didukung." });
  });
}

if (require.main === module) {
  createServer().listen(config.port, config.host, () => {
    console.log(`Thrift Query Workbench running at http://${config.host}:${config.port}`);
  });
}

module.exports = {
  config,
  createServer,
  getHealth,
  handleQuery,
  parseCsv,
  readJsonBody,
  runBeeline,
};

