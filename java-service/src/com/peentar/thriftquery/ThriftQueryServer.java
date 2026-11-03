package com.peentar.thriftquery;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
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
        server.createContext("/api/query", this::query);
        server.createContext("/api/namespaces", this::namespaces);
        server.createContext("/", this::staticFiles);
        server.setExecutor(executor);
        server.start();
        System.out.println("Thrift Query Workbench (Java JDBC) running at http://" + config.host + ":" + config.port);
        System.out.println("JDBC driver: org.apache.hive.jdbc.HiveDriver");
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
        String status = config.configured() ? "ok" : "degraded";
        sendJson(exchange, 200, "{\"status\":" + JsonUtil.quote(status)
                + ",\"configured\":" + config.configured()
                + ",\"readOnly\":true"
                + ",\"target\":" + JsonUtil.quote(config.redactedTarget()) + "}");
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
            sendJson(exchange, 503, error("Hive JDBC driver tidak ditemukan di classpath Java."));
        } catch (SQLException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 502, error("Query gagal dijalankan. Periksa koneksi dan kredensial Hive JDBC."));
        } finally {
            exchange.close();
        }
    }

    private void namespaces(HttpExchange exchange) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            methodNotAllowed(exchange);
            return;
        }
        try {
            List<String> namespaces = jdbc.namespaces();
            sendJson(exchange, 200, "{\"namespaces\":" + JsonUtil.stringArray(namespaces) + "}");
        } catch (IllegalStateException error) {
            sendJson(exchange, 503, error("Koneksi database belum dikonfigurasi di server."));
        } catch (SQLTimeoutException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 504, error("Namespace tidak dapat dimuat karena query melewati batas waktu."));
        } catch (ClassNotFoundException | SQLException error) {
            logDatabaseFailure(error);
            sendJson(exchange, 502, error("Namespace tidak dapat dimuat. Periksa koneksi dan kredensial Hive JDBC."));
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
