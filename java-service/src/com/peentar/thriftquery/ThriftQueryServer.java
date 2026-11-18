package com.peentar.thriftquery;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Collectors;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class ThriftQueryServer {
    private static final int MAX_BODY_BYTES = 64 * 1024;
    private static final int MAX_SQL_LENGTH = 20_000;

    private final AppConfig config;
    private final ConnectionWorkspaces workspaces;
    private final RequestAuth auth;
    private final ActivityAudit audit;
    private final ActivityApi activity;
    private final McpApi mcpApi;
    private final McpServer mcp;
    private final LocalMcpControl localMcp;
    private final ExecutorService executor = Executors.newFixedThreadPool(8);
    private HttpServer server;
    private boolean stopped;

    private ThriftQueryServer(AppConfig config) {
        this(config, new ConnectionWorkspaces(config));
    }

    ThriftQueryServer(AppConfig config, ConnectionWorkspaces workspaces) {
        this(config, workspaces, new GitHubAuth(config.auth));
    }

    ThriftQueryServer(AppConfig config, ConnectionWorkspaces workspaces, RequestAuth auth) {
        if (config.localMode ? !(auth instanceof LocalAuth local && workspaces.localOwner(local)) : auth instanceof LocalAuth)
            throw new IllegalArgumentException("Authentication mode does not match the workspace configuration.");
        this.config = config;
        this.workspaces = workspaces;
        this.audit = new ActivityAudit(config);
        this.activity = new ActivityApi(audit);
        McpTokenStore tokens = new McpTokenStore(config.dataDir);
        this.localMcp = config.localMode ? new LocalMcpControl(config, workspaces, workspaces.localWorkspace(), tokens, audit.store) : null;
        this.auth = config.localMode ? ((LocalAuth) auth).withMcp(localMcp) : auth;
        this.mcpApi = config.localMode ? new McpApi(tokens, localMcp, ((LocalAuth) auth).owner()) : new McpApi(tokens, config.auth.appUrl());
        this.mcp = config.localMode ? null : new McpServer(config, workspaces, tokens, audit.store);
        if (config.localMode) workspaces.forOwner(((LocalAuth) auth).owner());
    }

    public static void main(String[] args) throws Exception {
        Path projectRoot = Path.of(".").toAbsolutePath().normalize();
        AppConfig config = AppConfig.load(projectRoot);
        if (args.length > 0 && "--check".equals(args[0])) {
            System.out.println("Java service configuration: ready (connections added through UI)");
            System.out.println("Static directory: " + config.publicDir);
            return;
        }
        if (!Files.isDirectory(config.publicDir)) throw new IllegalStateException("Missing public directory: " + config.publicDir);

        ThriftQueryServer application = new ThriftQueryServer(config);
        application.start();
        Runtime.getRuntime().addShutdownHook(new Thread(application::stop));
    }

    private void start() throws IOException { start(config.port); }

    synchronized void start(int port) throws IOException {
        if (stopped || server != null) throw new IllegalStateException("Engine has already started or stopped.");
        if (config.localMode && (!config.host.equals("127.0.0.1") || config.port != 0 || port != 0 || !(auth instanceof LocalAuth)))
            throw new IllegalArgumentException("Local engine requires an authenticated ephemeral loopback socket.");
        server = HttpServer.create(new InetSocketAddress(config.host, port), 0);
        if (localMcp != null) {
            try { localMcp.start(); }
            catch (IOException | RuntimeException failure) { server.stop(0); server = null; throw failure; }
            route("/api/local/mcp", (exchange, connections) -> localMcp.handle(exchange));
        }
        // HttpServer contexts match prefixes: keep this browser asset out of /mcp.
        if (!config.localMode) {
            route("/mcp.js", this::staticFiles);
            server.createContext("/mcp", mcp::handle);
        }
        route("/api/mcp/tokens", (exchange, connections) -> mcpApi.handle(exchange, auth.actor(exchange), connections));
        route("/api/activity", (exchange, connections) -> activity.handle(exchange, auth.actor(exchange)));
        route("/api/health", this::health);
        route("/api/connections", this::connectionRoutes);
        route("/api/query", this::query);
        route("/api/databases", this::databases);
        route("/api/namespaces", this::namespaces);
        route("/api/tables", (exchange, connections) -> metadata(exchange, connections, false));
        route("/api/columns", (exchange, connections) -> metadata(exchange, connections, true));
        route("/", config.localMode ? (exchange, connections) -> sendJson(exchange, 404, error("Endpoint not found.")) : this::staticFiles);
        server.setExecutor(executor);
        server.start();
        if (!config.localMode) {
            System.out.println("GridBase (Java JDBC) running at http://" + config.host + ":" + port());
            System.out.println("Database connections are private to each GitHub account.");
            if (!config.auth.configured()) System.out.println("GitHub login belum dikonfigurasi. Isi GITHUB_CLIENT_ID dan GITHUB_CLIENT_SECRET di .env.");
        }
    }

    private interface AccountHandler { void handle(HttpExchange exchange, ConnectionRegistry connections) throws IOException; }

    private void route(String path, AccountHandler handler) {
        server.createContext(path, incoming -> {
            Actor verified = auth.actor(incoming);
            ActivityAudit.Exchange exchange = config.localMode && verified != null
                    ? audit.wrap(incoming, verified, config.clientKind) : audit.wrap(incoming, verified);
            try {
                if (auth.handle(exchange, config.auditAdminIds)) return;
                Actor user = auth.actor(exchange);
                String actual = exchange.getRequestURI().getPath();
                if (actual.startsWith("/api/") && user == null) {
                    sendJson(exchange, 401, error("Silakan login dengan GitHub.")); return;
                }
                if (!path.equals("/") && !path.equals("/api/connections") && !path.equals("/api/activity") && !path.equals("/api/mcp/tokens") && !actual.equals(path)) {
                    sendJson(exchange, 404, error("Endpoint tidak ditemukan.")); return;
                }
                exchange.beginOperation();
                boolean profiles = actual.startsWith("/api/") && !actual.startsWith("/api/activity");
                ConnectionRegistry connections = user != null && profiles ? workspaces.forOwner(user) : null;
                handler.handle(exchange, connections);
            } catch (BodyTooLarge oversized) { sendJson(exchange, 413, error("Request body too large.")); }
            catch (AuditStore.Unavailable unavailable) { sendJson(exchange, 503, error(unavailable.getMessage())); }
            catch (McpTokenStore.Unavailable unavailable) { sendJson(exchange, 503, error(unavailable.getMessage())); }
            catch (ConnectionStore.StoreException unavailable) { sendJson(exchange, 503, error(unavailable.getMessage())); }
            catch (IllegalArgumentException invalid) { sendJson(exchange, 400, error("Request tidak valid.")); }
            catch (Exception failure) {
                if (exchange.getResponseCode() < 0) sendJson(exchange, 500, error("Request gagal diproses."));
            } finally { exchange.close(); }
        });
    }

    int port() { return server.getAddress().getPort(); }

    synchronized void stop() {
        if (stopped) return;
        stopped = true;
        if (server != null) server.stop(0);
        executor.shutdownNow();
        if (mcp != null) mcp.close();
        if (localMcp != null) localMcp.close();
        // The caller owns the workspace lock: never return while a request can still use it.
        boolean interrupted = false;
        while (config.localMode && !executor.isTerminated()) {
            try { executor.awaitTermination(1, java.util.concurrent.TimeUnit.SECONDS); }
            catch (InterruptedException interruption) { interrupted = true; }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }

    private void health(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            methodNotAllowed(exchange);
            return;
        }
        sendJson(exchange, 200, healthPayload(connections));
    }

    private String healthPayload(ConnectionRegistry connections) {
        synchronized (connections) {
            ConnectionRegistry.Entry entry = connections.defaultEntry();
            ConnectionProfile profile = entry == null ? null : entry.service().profile();
            boolean configured = connections.entries().stream().anyMatch(ConnectionRegistry.Entry::connected);
            return "{\"status\":" + JsonUtil.quote(configured ? "ok" : "degraded")
                    + ",\"configured\":" + configured
                    + ",\"readOnly\":false"
                    + ",\"databaseType\":" + JsonUtil.quote(profile == null ? null : profile.type().id())
                    + ",\"connectionName\":" + JsonUtil.quote(profile == null ? null : profile.name())
                    + ",\"target\":" + JsonUtil.quote(profile == null ? null : profile.redactedUrl()) + "}";
        }
    }

    private void testConnection(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) { methodNotAllowed(exchange); return; }
        try {
            String body = readBody(exchange);
            String id = JsonUtil.stringFieldOrDefault(body, "connectionId", "");
            ActivityAudit.connection(exchange, id);
            connections.checkWritable(id);
            ConnectionProfile candidate = ConnectionProfile.fromJson(body);
            connections.test(candidate);
            sendJson(exchange, 200, "{\"ok\":true,\"connection\":" + candidate.safeJson() + "}");
        } catch (ConnectionRegistry.UnknownConnectionException error) {
            sendJson(exchange, 404, error(error.getMessage()));
        } catch (ConnectionStore.StoreException error) {
            sendJson(exchange, 503, error(error.getMessage()));
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, error(error.getMessage()));
        } catch (ClassNotFoundException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 503, error("Driver JDBC tidak ditemukan. Tambahkan driver PostgreSQL/MySQL ke classpath Java."));
        } catch (SQLException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 502, error(databaseFailureMessage("Koneksi", error)));
        }
    }

    private void connectionRoutes(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        if ("POST".equals(exchange.getRequestMethod())) {
            switch (exchange.getRequestURI().getPath()) {
                case "/api/connections/test" -> { testConnection(exchange, connections); return; }
                case "/api/connections/connect" -> { connect(exchange, connections); return; }
                case "/api/connections/disconnect" -> { disconnect(exchange, connections); return; }
            }
        }
        listConnections(exchange, connections);
    }

    private void connect(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) { methodNotAllowed(exchange); return; }
        try {
            String body = readBody(exchange);
            ConnectionSettings candidate = ConnectionSettings.fromJson(body);
            String id = auditTarget(exchange, body, true);
            ConnectionRegistry.Entry entry = connections.connect(id, candidate);
            sendJson(exchange, 200, "{\"ok\":true,\"connection\":" + entry.toJson() + "}");
        } catch (ConnectionRegistry.UnknownConnectionException error) {
            sendJson(exchange, 404, error(error.getMessage()));
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, error(error.getMessage()));
        } catch (ConnectionStore.StoreException error) {
            sendJson(exchange, 503, error(error.getMessage()));
        } catch (ClassNotFoundException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 503, error("Driver JDBC tidak ditemukan. Tambahkan driver ke classpath Java."));
        } catch (SQLException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 502, error(databaseFailureMessage("Koneksi", error)));
        }
    }

    private void disconnect(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) { methodNotAllowed(exchange); return; }
        try {
            String id = auditTarget(exchange, readBody(exchange), false);
            connections.disconnect(id);
            sendJson(exchange, 200, "{\"ok\":true}");
        } catch (ConnectionRegistry.UnknownConnectionException error) {
            sendJson(exchange, 404, error(error.getMessage()));
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, error("ID koneksi wajib diisi."));
        }
    }

    private void listConnections(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        String path = exchange.getRequestURI().getPath();
        String method = exchange.getRequestMethod();
        try {
            if (path.equals("/api/connections")) {
                if (method.equals("GET")) {
                    synchronized (connections) {
                        sendJson(exchange, 200, "{\"defaultConnectionId\":" + JsonUtil.quote(connections.defaultId())
                                + ",\"connections\":[" + connections.entries().stream().map(ConnectionRegistry.Entry::toJson).collect(Collectors.joining(",")) + "]}");
                    }
                } else if (method.equals("POST")) {
                    String body = readBody(exchange);
                    String id = auditTarget(exchange, body, true);
                    var entry = connections.save(id, ConnectionSettings.fromJson(body));
                    sendJson(exchange, 200, "{\"ok\":true,\"connection\":" + entry.toJson() + "}");
                } else methodNotAllowed(exchange);
            } else if (path.matches("/api/connections/[a-zA-Z0-9_-]{1,100}")) {
                String id = path.substring("/api/connections/".length());
                ActivityAudit.connection(exchange, id);
                if (method.equals("GET")) {
                    String details = connections.details(id).toJson();
                    sendJson(exchange, 200, "{\"id\":" + JsonUtil.quote(id) + "," + details.substring(1));
                } else if (method.equals("DELETE")) {
                    connections.delete(id);
                    sendJson(exchange, 200, "{\"ok\":true}");
                } else methodNotAllowed(exchange);
            } else sendJson(exchange, 404, error("Endpoint tidak ditemukan."));
        } catch (ConnectionRegistry.UnknownConnectionException error) {
            sendJson(exchange, 404, error(error.getMessage()));
        } catch (ConnectionStore.StoreException error) {
            sendJson(exchange, 503, error(error.getMessage()));
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, error(error.getMessage()));
        }
    }

    private void query(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            methodNotAllowed(exchange);
            return;
        }
        try {
            String body = readBody(exchange);
            String sql = JsonUtil.stringField(body, "sql");
            ActivityAudit.sql(exchange, sql);
            SqlPolicy.Result validation = SqlPolicy.validate(sql, MAX_SQL_LENGTH);
            if (!validation.ok()) {
                sendJson(exchange, 422, error(validation.error()));
                return;
            }
            JdbcService jdbc = auditedService(exchange, connections, JsonUtil.stringFieldOrDefault(body, "connectionId", ""));
            var result = jdbc.query(validation.sql());
            ActivityAudit.result(exchange, result);
            sendJson(exchange, 200, "{\"requestId\":" + JsonUtil.quote(ActivityAudit.requestId(exchange)) + "," + result.toJson().substring(1));
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, error("Request tidak valid."));
        } catch (ConnectionRegistry.UnknownConnectionException error) {
            sendJson(exchange, 404, error(error.getMessage()));
        } catch (IllegalStateException error) {
            sendJson(exchange, 503, error("Koneksi database belum dikonfigurasi di server."));
        } catch (SQLTimeoutException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 504, error("Query melewati batas waktu. Coba persempit filter atau batasi jumlah baris."));
        } catch (ClassNotFoundException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 503, error("Driver JDBC tidak ditemukan di classpath Java."));
        } catch (SQLException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 502, error(databaseFailureMessage("Query", error)));
        }
    }

    private void databases(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        databaseList(exchange, connections, "databases", "Database");
    }

    @Deprecated
    private void namespaces(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        databaseList(exchange, connections, "namespaces", "Namespace");
    }

    private void databaseList(HttpExchange exchange, ConnectionRegistry connections, String responseField, String label) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            methodNotAllowed(exchange);
            return;
        }
        try {
            List<String> databases = auditedService(exchange, connections, queryParams(exchange).get("connectionId")).databases();
            sendJson(exchange, 200, "{\"" + responseField + "\":" + JsonUtil.stringArray(databases) + "}");
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, error("Parameter koneksi tidak valid."));
        } catch (ConnectionRegistry.UnknownConnectionException error) {
            sendJson(exchange, 404, error(error.getMessage()));
        } catch (IllegalStateException error) {
            sendJson(exchange, 503, error("Koneksi database belum dikonfigurasi di server."));
        } catch (SQLTimeoutException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 504, error(label + " tidak dapat dimuat karena query melewati batas waktu."));
        } catch (ClassNotFoundException | SQLException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 502, error(label + " tidak dapat dimuat. Periksa koneksi dan kredensial database."));
        }
    }

    private void metadata(HttpExchange exchange, ConnectionRegistry connections, boolean columns) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) { methodNotAllowed(exchange); return; }
        try {
            Map<String, String> params = queryParams(exchange);
            JdbcService jdbc = auditedService(exchange, connections, params.get("connectionId"));
            String namespace = params.get("namespace");
            String payload = columns
                    ? "{\"columns\":[" + jdbc.columns(namespace, params.get("table")).stream().map(JdbcService.Column::toJson).collect(Collectors.joining(",")) + "]}"
                    : "{\"tables\":" + JsonUtil.stringArray(jdbc.tables(namespace)) + "}";
            sendJson(exchange, 200, payload);
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 422, error("Identifier wajib diisi, maksimal 256 karakter, tanpa karakter kontrol."));
        } catch (ConnectionRegistry.UnknownConnectionException error) {
            sendJson(exchange, 404, error(error.getMessage()));
        } catch (IllegalStateException error) {
            sendJson(exchange, 503, error("Koneksi database belum dikonfigurasi di server."));
        } catch (SQLTimeoutException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 504, error("Metadata melewati batas waktu. Coba refresh kembali."));
        } catch (ClassNotFoundException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 503, error("Driver JDBC tidak ditemukan di classpath Java."));
        } catch (SQLException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 502, error("Metadata tidak dapat dimuat. Periksa koneksi database lalu refresh."));
        }
    }

    private static String auditTarget(HttpExchange exchange, String body, boolean create) {
        String id = JsonUtil.stringFieldOrDefault(body, "connectionId", "");
        if (create && id.isBlank()) id = java.util.UUID.randomUUID().toString();
        ActivityAudit.connection(exchange, id);
        return id;
    }

    private static JdbcService auditedService(HttpExchange exchange, ConnectionRegistry connections, String requestedId) {
        String id;
        JdbcService jdbc;
        synchronized (connections) {
            id = requestedId == null || requestedId.isBlank() ? connections.defaultId() : requestedId;
            // Record even unknown targets, but capture the immutable service under the same lock.
            ActivityAudit.connection(exchange, id);
            jdbc = connections.require(id);
        }
        return jdbc;
    }

    private static Map<String, String> queryParams(HttpExchange exchange) {
        Map<String, String> params = new HashMap<>();
        String raw = exchange.getRequestURI().getRawQuery();
        if (raw != null) for (String pair : raw.split("&")) {
            String[] parts = pair.split("=", 2);
            params.put(URLDecoder.decode(parts[0], StandardCharsets.UTF_8),
                    parts.length == 2 ? URLDecoder.decode(parts[1], StandardCharsets.UTF_8) : "");
        }
        return params;
    }

    private void staticFiles(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            methodNotAllowed(exchange);
            return;
        }
        String requestedPath = exchange.getRequestURI().getPath();
        if (requestedPath == null || requestedPath.equals("/")) requestedPath = "/index.html";
        if (requestedPath.equals("/login")) requestedPath = "/login.html";
        Path file = config.publicDir.resolve("." + requestedPath).normalize();
        if (!file.startsWith(config.publicDir)) {
            sendJson(exchange, 403, error("Akses ditolak."));
            return;
        }
        if (!Files.isRegularFile(file)) {
            sendJson(exchange, 404, error("Halaman tidak ditemukan."));
            return;
        }
        byte[] content = Files.readAllBytes(file);
        Headers headers = exchange.getResponseHeaders();
        applySecurityHeaders(headers);
        headers.set("Content-Type", contentType(file));
        headers.set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(200, content.length);
        try (var output = exchange.getResponseBody()) {
            output.write(content);
        }
    }

    static String readBody(HttpExchange exchange) throws IOException {
        // Exchange owns the input lifetime. Closing it before sending an error
        // can reset a body-bearing socket and discard the typed JSON response.
        byte[] bytes = exchange.getRequestBody().readNBytes(MAX_BODY_BYTES + 1);
        if (bytes.length > MAX_BODY_BYTES) throw new BodyTooLarge();
        return new String(bytes, StandardCharsets.UTF_8);
    }
    private static final class BodyTooLarge extends IOException { }

    static void sendJson(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        Headers headers = exchange.getResponseHeaders();
        applySecurityHeaders(headers);
        headers.set("Content-Type", "application/json; charset=utf-8");
        headers.set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) {
            output.write(bytes);
        }
    }

    private static void methodNotAllowed(HttpExchange exchange) throws IOException {
        exchange.getResponseHeaders().set("Allow", "GET, POST");
        sendJson(exchange, 405, error("Method tidak didukung."));
    }

    private static String error(String message) {
        return "{\"error\":" + JsonUtil.quote(message) + "}";
    }

    private static String databaseFailureMessage(String operation, SQLException error) {
        String detail = error.getMessage();
        if (detail == null || detail.isBlank()) return operation + " gagal. Periksa host, port, database, username, dan password.";
        detail = detail.replaceAll("(?i)(password|pwd|secret|token)=?[^\\s;,&]*", "$1=••••••");
        if (detail.length() > 320) detail = detail.substring(0, 320);
        return operation + " gagal: " + detail;
    }

    static void applySecurityHeaders(Headers headers) {
        headers.set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
        headers.set("Referrer-Policy", "no-referrer");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("X-Frame-Options", "DENY");
    }

    private static String contentType(Path file) {
        String name = file.getFileName().toString().toLowerCase();
        if (name.endsWith(".html")) return "text/html; charset=utf-8";
        if (name.endsWith(".css")) return "text/css; charset=utf-8";
        if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (name.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private static void logDatabaseFailure(Exception error) {
        if (error instanceof SQLException sqlError) {
            System.err.println("JDBC request failed: " + sqlError.getClass().getSimpleName() + " state=" + sqlError.getSQLState());
        } else {
            System.err.println("JDBC request failed: " + error.getClass().getSimpleName());
        }
    }
}
