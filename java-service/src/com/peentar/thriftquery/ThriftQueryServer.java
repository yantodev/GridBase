package com.peentar.thriftquery;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
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
    private final GitHubAuth auth;
    private final ExecutorService executor = Executors.newFixedThreadPool(8);
    private HttpServer server;

    private ThriftQueryServer(AppConfig config) {
        this(config, new ConnectionWorkspaces(config));
    }

    ThriftQueryServer(AppConfig config, ConnectionWorkspaces workspaces) {
        this(config, workspaces, new GitHubAuth(config.auth));
    }

    ThriftQueryServer(AppConfig config, ConnectionWorkspaces workspaces, GitHubAuth auth) {
        this.config = config;
        this.workspaces = workspaces;
        this.auth = auth;
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

    void start(int port) throws IOException {
        server = HttpServer.create(new InetSocketAddress(config.host, port), 0);
        route("/api/health", this::health);
        route("/api/connections", this::connectionRoutes);
        route("/api/query", this::query);
        route("/api/databases", this::databases);
        route("/api/namespaces", this::namespaces);
        route("/api/tables", (exchange, connections) -> metadata(exchange, connections, false));
        route("/api/columns", (exchange, connections) -> metadata(exchange, connections, true));
        route("/", this::staticFiles);
        server.setExecutor(executor);
        server.start();
        System.out.println("GridBase (Java JDBC) running at http://" + config.host + ":" + port());
        System.out.println("Database connections are private to each GitHub account.");
        if (!config.auth.configured()) System.out.println("GitHub login belum dikonfigurasi. Isi GITHUB_CLIENT_ID dan GITHUB_CLIENT_SECRET di .env.");
    }

    private interface AccountHandler { void handle(HttpExchange exchange, ConnectionRegistry connections) throws IOException; }

    private void route(String path, AccountHandler handler) {
        server.createContext(path, exchange -> {
            if (auth.handle(exchange)) return;
            try {
                GitHubAuth.User user = auth.user(exchange);
                if (exchange.getRequestURI().getPath().startsWith("/api/") && user == null) {
                    sendJson(exchange, 401, error("Silakan login dengan GitHub.")); return;
                }
                ConnectionRegistry connections = user != null && exchange.getRequestURI().getPath().startsWith("/api/")
                        ? workspaces.forOwner(user.id()) : null;
                handler.handle(exchange, connections);
            } catch (ConnectionStore.StoreException unavailable) { sendJson(exchange, 503, error(unavailable.getMessage())); }
        });
    }

    int port() { return server.getAddress().getPort(); }

    void stop() {
        if (server != null) server.stop(0);
        executor.shutdownNow();
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
            connections.checkWritable(JsonUtil.stringFieldOrDefault(body, "connectionId", ""));
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
        } finally {
            exchange.close();
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
            ConnectionRegistry.Entry entry = connections.connect(JsonUtil.stringFieldOrDefault(body, "connectionId", ""), candidate);
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
        } finally {
            exchange.close();
        }
    }

    private void disconnect(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) { methodNotAllowed(exchange); return; }
        try {
            connections.disconnect(JsonUtil.stringField(readBody(exchange), "connectionId"));
            sendJson(exchange, 200, "{\"ok\":true}");
        } catch (ConnectionRegistry.UnknownConnectionException error) {
            sendJson(exchange, 404, error(error.getMessage()));
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, error("ID koneksi wajib diisi."));
        } finally { exchange.close(); }
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
                    var entry = connections.save(JsonUtil.stringFieldOrDefault(body, "connectionId", ""), ConnectionSettings.fromJson(body));
                    sendJson(exchange, 200, "{\"ok\":true,\"connection\":" + entry.toJson() + "}");
                } else methodNotAllowed(exchange);
            } else if (path.matches("/api/connections/[a-zA-Z0-9_-]{1,100}")) {
                String id = path.substring("/api/connections/".length());
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
        } finally { exchange.close(); }
    }

    private void query(HttpExchange exchange, ConnectionRegistry connections) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            methodNotAllowed(exchange);
            return;
        }
        try {
            String body = readBody(exchange);
            String sql = JsonUtil.stringField(body, "sql");
            SqlPolicy.Result validation = SqlPolicy.validate(sql, MAX_SQL_LENGTH);
            if (!validation.ok()) {
                sendJson(exchange, 422, error(validation.error()));
                return;
            }
            sendJson(exchange, 200, connections.require(JsonUtil.stringFieldOrDefault(body, "connectionId", "")).query(validation.sql()).toJson());
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
        } finally {
            exchange.close();
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
            List<String> databases = connections.require(queryParams(exchange).get("connectionId")).databases();
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
        } finally {
            exchange.close();
        }
    }

    private void metadata(HttpExchange exchange, ConnectionRegistry connections, boolean columns) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) { methodNotAllowed(exchange); return; }
        try {
            Map<String, String> params = queryParams(exchange);
            JdbcService jdbc = connections.require(params.get("connectionId"));
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
        } finally {
            exchange.close();
        }
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

    private static String readBody(HttpExchange exchange) throws IOException {
        String contentLength = exchange.getRequestHeaders().getFirst("Content-Length");
        if (contentLength != null && Integer.parseInt(contentLength) > MAX_BODY_BYTES) {
            throw new IOException("Request body too large");
        }
        try (InputStream input = exchange.getRequestBody(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_BODY_BYTES) throw new IOException("Request body too large");
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8);
        }
    }

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
