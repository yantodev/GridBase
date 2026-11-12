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
    private final JdbcService jdbc;
    private final ExecutorService executor = Executors.newFixedThreadPool(8);
    private HttpServer server;

    private ThriftQueryServer(AppConfig config) {
        this.config = config;
        this.jdbc = new JdbcService(config);
    }

    public static void main(String[] args) throws Exception {
        Path projectRoot = Path.of(".").toAbsolutePath().normalize();
        AppConfig config = AppConfig.load(projectRoot);
        if (args.length > 0 && "--check".equals(args[0])) {
            System.out.println("Java service configuration: " + (config.configured() ? "ready" : "incomplete"));
            System.out.println("JDBC target: " + config.redactedTarget());
            System.out.println("Static directory: " + config.publicDir);
            return;
        }
        if (!Files.isDirectory(config.publicDir)) throw new IllegalStateException("Missing public directory: " + config.publicDir);

        ThriftQueryServer application = new ThriftQueryServer(config);
        application.start();
        Runtime.getRuntime().addShutdownHook(new Thread(application::stop));
    }

    private void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress(config.host, config.port), 0);
        server.createContext("/api/health", this::health);
        server.createContext("/api/connections/test", this::testConnection);
        server.createContext("/api/connections/connect", this::connect);
        server.createContext("/api/connections/disconnect", this::disconnect);
        server.createContext("/api/query", this::query);
        server.createContext("/api/databases", this::databases);
        server.createContext("/api/namespaces", this::namespaces);
        server.createContext("/api/tables", exchange -> metadata(exchange, false));
        server.createContext("/api/columns", exchange -> metadata(exchange, true));
        server.createContext("/", this::staticFiles);
        server.setExecutor(executor);
        server.start();
        System.out.println("GridBase (Java JDBC) running at http://" + config.host + ":" + config.port);
        System.out.println("JDBC driver: " + (jdbc.profile() == null ? "not configured" : jdbc.profile().type().driverClass()));
    }

    private void stop() {
        if (server != null) server.stop(0);
        executor.shutdownNow();
    }

    private void health(HttpExchange exchange) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            methodNotAllowed(exchange);
            return;
        }
        sendJson(exchange, 200, healthPayload());
    }

    private String healthPayload() {
        ConnectionProfile profile = jdbc.profile();
        String status = profile == null ? "degraded" : "ok";
        return "{\"status\":" + JsonUtil.quote(status)
                + ",\"configured\":" + (profile != null)
                + ",\"readOnly\":false"
                + ",\"databaseType\":" + JsonUtil.quote(profile == null ? null : profile.type().id())
                + ",\"connectionName\":" + JsonUtil.quote(profile == null ? null : profile.name())
                + ",\"target\":" + JsonUtil.quote(profile == null ? config.redactedTarget() : profile.redactedUrl()) + "}";
    }

    private void testConnection(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) { methodNotAllowed(exchange); return; }
        try {
            ConnectionProfile candidate = ConnectionProfile.fromJson(readBody(exchange));
            jdbc.testConnection(candidate);
            sendJson(exchange, 200, "{\"ok\":true,\"connection\":" + candidate.safeJson() + "}");
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

    private void connect(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) { methodNotAllowed(exchange); return; }
        try {
            ConnectionProfile candidate = ConnectionProfile.fromJson(readBody(exchange));
            jdbc.connect(candidate);
            sendJson(exchange, 200, "{\"ok\":true,\"connection\":" + candidate.safeJson() + "}");
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, error(error.getMessage()));
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

    private void disconnect(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) { methodNotAllowed(exchange); return; }
        jdbc.disconnect();
        sendJson(exchange, 200, "{\"ok\":true}");
        exchange.close();
    }

    private void query(HttpExchange exchange) throws IOException {
        if (!"POST".equals(exchange.getRequestMethod())) {
            methodNotAllowed(exchange);
            return;
        }
        try {
            String sql = JsonUtil.stringField(readBody(exchange), "sql");
            SqlPolicy.Result validation = SqlPolicy.validate(sql, MAX_SQL_LENGTH);
            if (!validation.ok()) {
                sendJson(exchange, 422, error(validation.error()));
                return;
            }
            sendJson(exchange, 200, jdbc.query(validation.sql()).toJson());
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 400, error("Request tidak valid."));
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

    private void databases(HttpExchange exchange) throws IOException {
        databaseList(exchange, "databases", "Database");
    }

    @Deprecated
    private void namespaces(HttpExchange exchange) throws IOException {
        databaseList(exchange, "namespaces", "Namespace");
    }

    private void databaseList(HttpExchange exchange, String responseField, String label) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            methodNotAllowed(exchange);
            return;
        }
        try {
            List<String> databases = jdbc.databases();
            sendJson(exchange, 200, "{\"" + responseField + "\":" + JsonUtil.stringArray(databases) + "}");
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

    private void metadata(HttpExchange exchange, boolean columns) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) { methodNotAllowed(exchange); return; }
        try {
            Map<String, String> params = new HashMap<>();
            String raw = exchange.getRequestURI().getRawQuery();
            if (raw != null) for (String pair : raw.split("&")) {
                String[] parts = pair.split("=", 2);
                params.put(URLDecoder.decode(parts[0], StandardCharsets.UTF_8),
                        parts.length == 2 ? URLDecoder.decode(parts[1], StandardCharsets.UTF_8) : "");
            }
            String namespace = params.get("namespace");
            String payload = columns
                    ? "{\"columns\":[" + jdbc.columns(namespace, params.get("table")).stream().map(JdbcService.Column::toJson).collect(Collectors.joining(",")) + "]}"
                    : "{\"tables\":" + JsonUtil.stringArray(jdbc.tables(namespace)) + "}";
            sendJson(exchange, 200, payload);
        } catch (IllegalArgumentException error) {
            sendJson(exchange, 422, error("Identifier wajib diisi, maksimal 256 karakter, tanpa karakter kontrol."));
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

    private void staticFiles(HttpExchange exchange) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            methodNotAllowed(exchange);
            return;
        }
        String requestedPath = exchange.getRequestURI().getPath();
        if (requestedPath == null || requestedPath.equals("/")) requestedPath = "/index.html";
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
        headers.set("Cache-Control", "no-cache");
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

    private static void sendJson(HttpExchange exchange, int status, String body) throws IOException {
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

    private static void applySecurityHeaders(Headers headers) {
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
