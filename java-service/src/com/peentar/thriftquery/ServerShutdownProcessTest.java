package com.peentar.thriftquery;

import java.io.*;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.sql.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

/** Actual GitHub-server JVM shutdown hook with a JDBC worker ignoring interruption. */
public final class ServerShutdownProcessTest {
    private static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    public static void main(String[] args) throws Exception {
        if (args.length != 0) { child(Path.of(args[0])); return; }
        Path fixture = Files.createTempDirectory("gridbase-server-shutdown-空 間");
        Path output = fixture.resolve("child-output.log");
        Process process = null;
        try {
            String cp = Arrays.stream(System.getProperty("java.class.path").split(java.util.regex.Pattern.quote(File.pathSeparator)))
                    .map(p -> Path.of(p).toAbsolutePath().normalize().toString()).collect(java.util.stream.Collectors.joining(File.pathSeparator));
            ProcessBuilder builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-ea", "--add-modules", "jdk.httpserver",
                    "-Djava.io.tmpdir=" + Path.of(System.getProperty("java.io.tmpdir")).toAbsolutePath(), "-cp", cp, ServerShutdownProcessTest.class.getName(), fixture.toString());
            String systemRoot = builder.environment().get("SystemRoot"); builder.environment().clear();
            if (systemRoot != null) builder.environment().put("SystemRoot", systemRoot);
            builder.environment().put("LANG", "C.UTF-8");
            process = builder.directory(fixture.toFile()).redirectErrorStream(true).redirectOutput(output.toFile()).start();
            await(fixture.resolve("port"), process);
            String base = "http://127.0.0.1:" + Files.readString(fixture.resolve("port"));
            String cookie = GitHubAuthTest.login(base);
            String profile = "{\"connectionId\":\"fixture\",\"type\":\"postgresql\",\"name\":\"Shutdown fixture\",\"host\":\"fixture.invalid\",\"database\":\"fixture\",\"username\":\"fixture\",\"password\":\"synthetic-password\"}";
            var connected = CLIENT.send(request(base, "/api/connections/connect", cookie, profile), HttpResponse.BodyHandlers.ofString());
            check(connected.statusCode() == 200, "Synthetic server connection succeeds");
            var query = CLIENT.sendAsync(request(base, "/api/query", cookie, "{\"connectionId\":\"fixture\",\"sql\":\"UPDATE fixture SET x=2\"}"), HttpResponse.BodyHandlers.ofString());
            await(fixture.resolve("jdbc-entered"), process);
            process.getOutputStream().write('\n'); process.getOutputStream().flush(); // Only this owned child's main invokes System.exit.
            await(fixture.resolve("hook-entered"), process);
            check(process.waitFor(5, TimeUnit.SECONDS), "Server shutdown hook must return despite JDBC ignoring interruption");
            check(process.exitValue() == 0, "Owned server JVM exits normally");
            check(Files.exists(fixture.resolve("jdbc-ignored-interrupt")), "Real request worker ignored executor interruption");
            check(Files.exists(fixture.resolve("hook-returned")), "Server stop returned to the actual shutdown hook");
            check(Files.readAllLines(fixture.resolve("jdbc-entered")).size() == 1, "No query retry during shutdown");
            try { query.get(5, TimeUnit.SECONDS); } catch (ExecutionException expected) { /* Uncertain response is not retried. */ }
            System.out.println("Server shutdown process passed: actual shutdown hook returned and JVM exited0 with unreleased JDBC worker ignoring interrupt");
        } finally {
            if (process != null && process.isAlive()) { process.destroyForcibly(); process.waitFor(5, TimeUnit.SECONDS); }
            if (Files.exists(output)) {
                String text = Files.readString(output);
                check(!text.contains("synthetic-password"), "Fixture credential absent from child diagnostics");
                System.out.println("SERVER_CHILD_OUTPUT_BEGIN\n" + text + "SERVER_CHILD_OUTPUT_END");
            }
            PrivateFilesTest.remove(fixture);
        }
    }
    private static HttpRequest request(String base, String path, String cookie, String body) {
        return HttpRequest.newBuilder(URI.create(base + path)).header("Cookie", cookie).header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(15)).POST(HttpRequest.BodyPublishers.ofString(body)).build();
    }
    private static void child(Path fixture) throws Exception {
        AppConfig config = AppConfig.load(fixture, Map.of("GITHUB_CLIENT_ID", "fixture", "GITHUB_CLIENT_SECRET", "fixture"));
        check(!config.localMode, "Actual server-mode configuration");
        var stores = new ConnectionWorkspaces(config, profile -> new JdbcService(config, profile, () -> jdbc(fixture)));
        var server = new ThriftQueryServer(config, stores, new GitHubAuth(config.auth, (code, verifier) -> new GitHubAuth.User("1001", "fixture-user")));
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            try {
                Files.writeString(fixture.resolve("hook-entered"), "entered", StandardOpenOption.CREATE_NEW);
                server.stop();
                Files.writeString(fixture.resolve("hook-returned"), "returned", StandardOpenOption.CREATE_NEW);
            } catch (IOException failure) { throw new UncheckedIOException(failure); }
        }, "fixture-server-shutdown-hook"));
        server.start(0);
        Files.writeString(fixture.resolve("port"), Integer.toString(server.port()), StandardOpenOption.CREATE_NEW);
        if (System.in.read() != '\n') throw new IOException("Missing fixture shutdown command");
        System.exit(0);
    }
    private static Connection jdbc(Path fixture) {
        Statement statement = (Statement) Proxy.newProxyInstance(ServerShutdownProcessTest.class.getClassLoader(), new Class[]{Statement.class}, (p, method, args) -> {
            switch (method.getName()) {
                case "execute":
                    Files.writeString(fixture.resolve("jdbc-entered"), "execute\n", StandardOpenOption.CREATE, StandardOpenOption.APPEND);
                    CountDownLatch neverReleased = new CountDownLatch(1);
                    while (true) {
                        try { neverReleased.await(); }
                        catch (InterruptedException ignored) { Files.writeString(fixture.resolve("jdbc-ignored-interrupt"), "ignored"); }
                    }
                case "setQueryTimeout", "close": return null;
                default: throw new UnsupportedOperationException(method.getName());
            }
        });
        return (Connection) Proxy.newProxyInstance(ServerShutdownProcessTest.class.getClassLoader(), new Class[]{Connection.class}, (p, method, args) -> switch (method.getName()) {
            case "isValid" -> true;
            case "createStatement" -> statement;
            case "setReadOnly", "close" -> null;
            default -> throw new UnsupportedOperationException(method.getName());
        });
    }
    private static void await(Path file, Process child) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!Files.exists(file)) {
            check(child.isAlive() && System.nanoTime() < deadline, "Owned child fixture barrier not reached: " + file.getFileName());
            Thread.sleep(10);
        }
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
