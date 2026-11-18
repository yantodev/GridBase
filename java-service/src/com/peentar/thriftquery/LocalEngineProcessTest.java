package com.peentar.thriftquery;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** Actual Java child processes: only fixture paths/data, no inherited secrets or services. */
public final class LocalEngineProcessTest {
    static final String CAP = LocalAuthTest.CAP;
    static byte[] keyBytes() { byte[] bytes = new byte[32]; Arrays.fill(bytes, (byte) 7); return bytes; }
    static final String KEY = Base64.getUrlEncoder().withoutPadding().encodeToString(keyBytes());
    static final String BOOT = "{\"protocol\":1,\"capability\":\"" + CAP + "\",\"credentialKey\":\"" + KEY + "\",\"clientKind\":\"desktop\"}\n";
    static final ExecutorService READERS = Executors.newCachedThreadPool(r -> { Thread t = new Thread(r, "fixture-pipe-reader"); t.setDaemon(true); return t; });
    static Path root;
    static int cases;
    static int processes;
    public static void main(String[] args) throws Exception {
        try { Class.forName("com.peentar.thriftquery.LocalEngineMain"); }
        catch (ClassNotFoundException missing) { throw new AssertionError("Local engine process entry point is not implemented", missing); }
        root = Files.createTempDirectory("gridbase-local-process 空 間");
        PrivateFiles.createDirectory(root);
        try {
            Path fixture = fixture("success");
            AtomicInteger contacts = new AtomicInteger();
            HttpServer unrelated = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            unrelated.createContext("/", e -> { contacts.incrementAndGet(); e.sendResponseHeaders(500, -1); e.close(); }); unrelated.start();
            try (Child child = launch(fixture, normalArgs(fixture), unrelated.getAddress().getPort())) {
                child.write(BOOT);
                JsonObject ready = child.ready();
                LocalAuthTest.check(ready.keySet().equals(Set.of("event", "protocol", "version", "pid", "port")), "Exact readiness fields");
                LocalAuthTest.check(ready.get("event").getAsString().equals("ready") && ready.get("protocol").getAsInt() == 1
                        && ready.get("version").getAsString().equals("7.8.9") && ready.get("pid").getAsLong() == child.process.pid(), "Version/resource/PID protocol");
                int port = ready.get("port").getAsInt();
                LocalAuthTest.check(port > 0 && port != unrelated.getAddress().getPort(), "Fresh allocated socket, not configured fixed port");
                LocalAuthTest.expect(LocalAuthTest.valid("http://127.0.0.1:" + port, "/api/connections"), 200);
                LocalAuthTest.expect(LocalAuthTest.request("http://127.0.0.1:" + port, "/healthz"), 401);
                for (String name : List.of("local-workspace.json", ".gridbase-local.lock", "gridbase.sqlite", "audit.sqlite", "mcp.sqlite"))
                    LocalAuthTest.check(Files.isRegularFile(fixture.resolve("data").resolve(name)), "Stores/lock exist before ready");
                LocalAuthTest.check(!Files.exists(fixture.resolve("data/credentials.key")), "Injected key only");
                try (var files = Files.list(fixture.resolve("temp"))) {
                    LocalAuthTest.check(files.anyMatch(p -> p.getFileName().toString().startsWith("sqlite-")), "SQLite native extraction uses explicit private temp despite hostile property");
                }
                try (Child contender = launch(fixture, normalArgs(fixture), 1)) { contender.write(BOOT); contender.failure(15); }
                child.process.getOutputStream().close();
                child.finish(0, 15);
                try (LocalWorkspace ignored = LocalWorkspace.open(fixture.resolve("data"), new CredentialKey(keyBytes()))) { }
                try { LocalAuthTest.CLIENT.send(LocalAuthTest.valid("http://127.0.0.1:" + port, "/healthz").build(), java.net.http.HttpResponse.BodyHandlers.ofString()); throw new AssertionError("Socket survived EOF"); }
                catch (IOException expected) { }
                LocalAuthTest.check(contacts.get() == 0, "Unrelated configured listener was never contacted");
                cases++;
            } finally { unrelated.stop(0); }
            // Preserve a real saved encrypted profile and authenticate it on restart.
            Path data = fixture.resolve("data");
            try (LocalWorkspace ws = LocalWorkspace.open(data, new CredentialKey(keyBytes()))) {
                new ConnectionWorkspaces(AppConfig.local(fixture.resolve("resources"), data, fixture.resolve("temp"), "desktop"), ws)
                        .forOwner(ws.actor()).save("fixture", ConnectionSettings.fromJson(LocalEngineHttpTest.PROFILE));
            }
            try (Child child = launch(fixture, normalArgs(fixture), 1)) {
                child.write(BOOT); int port = child.ready().get("port").getAsInt();
                LocalAuthTest.check(LocalAuthTest.expect(LocalAuthTest.valid("http://127.0.0.1:" + port, "/api/connections/fixture"), 200).body().contains("synthetic-password"), "Saved profile decrypted before readiness");
                child.process.getOutputStream().close(); child.finish(0, 15); cases++;
            }
            inFlightJdbcEof();
            List<byte[]> invalid = new ArrayList<>();
            for (String text : List.of("\n", "{}\n", BOOT.replace("\"protocol\":1", "\"protocol\":2"), BOOT.replace("\"protocol\":1", "\"protocol\":\"1\""),
                    BOOT.replace("\"protocol\":1", "\"protocol\":1.0"), BOOT.replace("\"protocol\":1", "\"protocol\":1,\"protocol\":1"),
                    BOOT.replace("\"clientKind\":\"desktop\"", "\"clientKind\":\"browser\""), BOOT.replace("\"clientKind\":\"desktop\"", "\"clientKind\":false"),
                    BOOT.replace("\"protocol\":1", "\"unknown\":true,\"protocol\":1"), BOOT.replace(CAP, "bad"), BOOT.replace(CAP, CAP + "="),
                    BOOT.replace(CAP, CAP.substring(0, 42) + "B"), BOOT.replace("\"credentialKey\":\"" + KEY + "\"", "\"credentialKey\":null"),
                    BOOT.replace(KEY, "bad"), BOOT.replace(KEY, KEY + "="), BOOT.replace(KEY, KEY.substring(0, 42) + "B"),
                    BOOT.replace(KEY, Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[31])),
                    BOOT.replace("\"protocol\":1", "\"protocol\":1,\"credentialKey\":\"" + KEY + "\""),
                    " ".repeat(8192) + BOOT, BOOT + "unexpected\n")) invalid.add(text.getBytes(StandardCharsets.UTF_8));
            invalid.add(new byte[]{(byte)0xc3, (byte)0x28, (byte)'\n'});
            for (byte[] bytes : invalid) {
                Path f = fixture("invalid-" + cases);
                try (Child child = launch(f, normalArgs(f), 1)) { child.process.getOutputStream().write(bytes); child.process.getOutputStream().flush(); child.failure(15); cases++; }
            }
            // Bound includes LF: exactly 8192 bytes valid; 8193 bytes invalid.
            for (int length : List.of(8192, 8193)) {
                Path f = fixture("limit-" + length);
                String line = " ".repeat(length - BOOT.getBytes(StandardCharsets.UTF_8).length) + BOOT;
                try (Child child = launch(f, normalArgs(f), 1)) {
                    child.write(line);
                    if (length == 8192) { child.ready(); child.process.getOutputStream().close(); child.finish(0, 15); }
                    else child.failure(15);
                    cases++;
                }
            }
            for (String input : List.of("", BOOT.stripTrailing(), BOOT)) {
                Path f = fixture("eof-before-" + cases);
                try (Child child = launch(f, normalArgs(f), 1)) { child.write(input); child.process.getOutputStream().close(); child.failure(15); cases++; }
            }
            Path timeout = fixture("timeout");
            try (Child child = launch(timeout, normalArgs(timeout), 1)) { child.write("{"); child.failure(20); cases++; }
            try (Child child = launch(timeout, normalArgs(timeout), 1)) { child.failure(20); cases++; }
            Path extra = fixture("extra-after-ready");
            try (Child child = launch(extra, normalArgs(extra), 1)) { child.write(BOOT); child.ready(); child.write("x"); child.finish(1, 15); cases++; }
            Path badVersion = fixture("bad-version"); Files.writeString(badVersion.resolve("resources/VERSION"), "unsafe\nversion\n");
            try (Child child = launch(badVersion, normalArgs(badVersion), 1)) { child.write(BOOT); child.failure(15); cases++; }
            Path missingVersion = fixture("missing-version"); Files.delete(missingVersion.resolve("resources/VERSION"));
            try (Child child = launch(missingVersion, normalArgs(missingVersion), 1)) { child.write(BOOT); child.failure(15); cases++; }
            Path futureAudit = fixture("future-audit");
            try (LocalWorkspace ignored = LocalWorkspace.open(futureAudit.resolve("data"), new CredentialKey(keyBytes()))) {
                new AuditStore(futureAudit.resolve("data"));
                try (var db = java.sql.DriverManager.getConnection("jdbc:sqlite:" + futureAudit.resolve("data/audit.sqlite")); var sql = db.createStatement()) { sql.execute("PRAGMA user_version=99"); }
            }
            try (Child child = launch(futureAudit, normalArgs(futureAudit), 1)) { child.write(BOOT); child.failure(15); cases++; }
            Path futureTokens = fixture("future-tokens");
            try (LocalWorkspace ignored = LocalWorkspace.open(futureTokens.resolve("data"), new CredentialKey(keyBytes()))) {
                new McpTokenStore(futureTokens.resolve("data"));
                try (var db = java.sql.DriverManager.getConnection("jdbc:sqlite:" + futureTokens.resolve("data/mcp.sqlite")); var sql = db.createStatement()) { sql.execute("PRAGMA user_version=99"); }
            }
            try (Child child = launch(futureTokens, normalArgs(futureTokens), 1)) { child.write(BOOT); child.failure(15); cases++; }
            Path wrongKey = fixture;
            try (Child child = launch(wrongKey, normalArgs(wrongKey), 1)) { child.write(BOOT.replace(KEY, Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]))); child.failure(15); cases++; }
            // Corrupt encrypted profile must fail before ready, not lazily on first API call.
            try (var db = java.sql.DriverManager.getConnection("jdbc:sqlite:" + data.resolve("gridbase.sqlite")); var sql = db.createStatement()) {
                sql.executeUpdate("UPDATE connections SET settings=x'00'");
            }
            try (Child child = launch(fixture, normalArgs(fixture), 1)) { child.write(BOOT); child.failure(15); cases++; }
            Path badArgs = fixture("arguments");
            for (List<String> arguments : List.of(List.<String>of(), List.of("--resources", "relative", "--data-dir", badArgs.resolve("data").toString(), "--temp-dir", badArgs.resolve("temp").toString()),
                    List.of("--unknown", "not-a-secret"), List.of("--port", "4173"), List.of("--resources", badArgs.resolve("resources").toString(), "--resources", badArgs.resolve("resources").toString()),
                    List.of("--resources", badArgs.resolve("resources").toString(), "--resources", badArgs.resolve("resources").toString(), "--temp-dir", badArgs.resolve("temp").toString()),
                    List.of("--unknown", badArgs.resolve("resources").toString(), "--data-dir", badArgs.resolve("data").toString(), "--temp-dir", badArgs.resolve("temp").toString()),
                    List.of("--resources"))) {
                try (Child child = launch(badArgs, arguments, 1)) { child.failure(15); cases++; }
            }
            System.out.println("Local engine process tests passed (" + cases + " scenarios, " + processes + " actual child JVMs: bootstrap bounds/deadline, private temp, ready, lock, stdin EOF/input, hostile cwd/env)");
        } finally { READERS.shutdownNow(); PrivateFilesTest.remove(root); }
    }
    // A disposable test-only JDBC driver exercises the *actual* entry point and
    // engine HTTP executor in a second JVM; nothing is added to production drivers.
    static void inFlightJdbcEof() throws Exception {
        Path f = fixture("jdbc-eof"), classes = f.resolve("test-driver-classes"), source = f.resolve("Driver.java");
        Files.createDirectory(classes);
        Files.writeString(source, """
                package org.postgresql;
                public class Driver implements java.sql.Driver {
                    static { try { java.sql.DriverManager.registerDriver(new Driver()); } catch (Exception e) { throw new ExceptionInInitializerError(e); } }
                    public java.sql.Connection connect(String url, java.util.Properties p) throws java.sql.SQLException {
                        return acceptsURL(url) ? com.peentar.thriftquery.LocalEngineProcessTest.childJdbc() : null;
                    }
                    public boolean acceptsURL(String url) { return url.startsWith("jdbc:postgresql:"); }
                    public java.sql.DriverPropertyInfo[] getPropertyInfo(String u, java.util.Properties p) { return new java.sql.DriverPropertyInfo[0]; }
                    public int getMajorVersion() { return 1; }
                    public int getMinorVersion() { return 0; }
                    public boolean jdbcCompliant() { return false; }
                    public java.util.logging.Logger getParentLogger() { return java.util.logging.Logger.getGlobal(); }
                }
                """);
        int compile = javax.tools.ToolProvider.getSystemJavaCompiler().run(null, System.out, System.err, "--release", "17", "-cp", System.getProperty("java.class.path"), "-d", classes.toString(), source.toString());
        LocalAuthTest.check(compile == 0, "Disposable isolated JDBC driver compiled");
        try (Child child = launch(f, normalArgs(f), 1)) {
            child.write(BOOT); String base = "http://127.0.0.1:" + child.ready().get("port").getAsInt();
            LocalEngineHttpTest.post(base, "/api/connections/connect", LocalEngineHttpTest.PROFILE, 200);
            var query = LocalAuthTest.CLIENT.sendAsync(LocalAuthTest.valid(base, "/api/query").header("Content-Type", "application/json")
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString("{\"sql\":\"UPDATE fixture SET x=2\"}")).build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            awaitFile(f.resolve("jdbc-entered"), child.process);
            child.process.getOutputStream().close();
            // The request is deliberately not interruptible. While shutdown is
            // waiting for it, a second process must still be unable to own data.
            try (Child contender = launch(f, normalArgs(f), 1)) { contender.write(BOOT); contender.failure(15); }
            LocalAuthTest.check(child.process.isAlive(), "EOF must retain lock until JDBC/request executor is finished");
            Files.writeString(f.resolve("jdbc-release"), "release", StandardOpenOption.CREATE_NEW);
            child.finish(0, 15);
            try { query.get(10, TimeUnit.SECONDS); } catch (ExecutionException expected) { /* EOF closed uncertain HTTP response. */ }
            LocalAuthTest.check(Files.readAllLines(f.resolve("jdbc-entered")).size() == 1, "Uncertain child-JVM write never retried");
            try (LocalWorkspace ignored = LocalWorkspace.open(f.resolve("data"), new CredentialKey(keyBytes()))) { }
            cases += 2; // Actual engine and locked contender.
        }
    }
    public static java.sql.Connection childJdbc() throws java.sql.SQLException {
        Path f = Path.of(System.getProperty("gridbase.fixture.jdbc"));
        var statement = (java.sql.Statement) java.lang.reflect.Proxy.newProxyInstance(LocalEngineProcessTest.class.getClassLoader(), new Class[]{java.sql.Statement.class}, (p, m, a) -> {
            switch (m.getName()) {
                case "execute":
                    Files.writeString(f.resolve("jdbc-entered"), "execute\n", StandardOpenOption.CREATE, StandardOpenOption.APPEND);
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
                    while (!Files.exists(f.resolve("jdbc-release"))) {
                        if (System.nanoTime() > deadline) throw new java.sql.SQLException("Fixture release deadline");
                        try { Thread.sleep(10); } catch (InterruptedException ignored) { /* Emulate a driver ignoring cancellation. */ }
                    }
                    return false;
                case "getUpdateCount": return 1;
                case "setQueryTimeout", "close": return null;
                default: throw new UnsupportedOperationException(m.getName());
            }
        });
        return (java.sql.Connection) java.lang.reflect.Proxy.newProxyInstance(LocalEngineProcessTest.class.getClassLoader(), new Class[]{java.sql.Connection.class}, (p, m, a) -> switch (m.getName()) {
            case "isValid" -> true;
            case "createStatement" -> statement;
            case "setReadOnly", "close" -> null;
            default -> throw new UnsupportedOperationException(m.getName());
        });
    }
    static void awaitFile(Path file, Process process) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!Files.exists(file)) {
            LocalAuthTest.check(process.isAlive() && System.nanoTime() < deadline, "Child JDBC barrier not reached");
            Thread.sleep(10);
        }
    }
    static Path fixture(String name) throws Exception {
        Path f = root.resolve(name); Files.createDirectories(f.resolve("resources/public")); Files.createDirectories(f.resolve("hostile cwd"));
        Files.writeString(f.resolve("resources/VERSION"), "7.8.9\n");
        Files.writeString(f.resolve("hostile cwd/VERSION"), "9.9.9\n");
        Files.writeString(f.resolve("hostile cwd/.env"), "PORT=1\nHOST=0.0.0.0\nGITHUB_CLIENT_ID=fixture\nGITHUB_CLIENT_SECRET=fixture\n");
        PrivateFiles.createDirectory(f.resolve("temp")); return f;
    }
    static List<String> normalArgs(Path f) { return List.of("--resources", f.resolve("resources").toString(), "--data-dir", f.resolve("data").toString(), "--temp-dir", f.resolve("temp").toString()); }
    static Child launch(Path f, List<String> args, int hostilePort) throws Exception {
        String cp = Arrays.stream(System.getProperty("java.class.path").split(java.util.regex.Pattern.quote(File.pathSeparator)))
                .map(p -> Path.of(p).toAbsolutePath().normalize().toString()).collect(java.util.stream.Collectors.joining(File.pathSeparator));
        if (Files.isDirectory(f.resolve("test-driver-classes"))) cp = f.resolve("test-driver-classes") + File.pathSeparator + cp;
        List<String> command = new ArrayList<>(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "--add-modules", "jdk.httpserver",
                "-Djava.io.tmpdir=" + f.resolve("temp"), "-Dorg.sqlite.tmpdir=" + f.resolve("untrusted temp"), "-Dgridbase.fixture.jdbc=" + f,
                "-cp", cp, "com.peentar.thriftquery.LocalEngineMain")); command.addAll(args);
        ProcessBuilder builder = new ProcessBuilder(command).directory(f.resolve("hostile cwd").toFile());
        String systemRoot = builder.environment().get("SystemRoot"); builder.environment().clear();
        if (systemRoot != null) builder.environment().put("SystemRoot", systemRoot);
        builder.environment().put("LANG", "C.UTF-8"); // Java 17 native argv paths must retain Unicode after env scrubbing.
        builder.environment().putAll(Map.of("HOST", "0.0.0.0", "PORT", Integer.toString(hostilePort), "APP_URL", "http://127.0.0.1:" + hostilePort, "AUTH_DISABLED", "true", "GITHUB_CLIENT_ID", "hostile-fixture", "GITHUB_CLIENT_SECRET", "hostile-fixture"));
        Child child = new Child(builder.start()); processes++; return child;
    }
    static final class Child implements AutoCloseable {
        final Process process;
        final BufferedReader stdout;
        final Future<String> stderr;
        String readyLine;
        Child(Process process) { this.process = process; stdout = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8)); stderr = READERS.submit(() -> new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8)); }
        void write(String text) throws Exception { process.getOutputStream().write(text.getBytes(StandardCharsets.UTF_8)); process.getOutputStream().flush(); }
        JsonObject ready() throws Exception {
            readyLine = READERS.submit(stdout::readLine).get(15, TimeUnit.SECONDS);
            LocalAuthTest.check(readyLine != null, "Child exited before ready (diagnostics redacted)");
            noSecrets(readyLine); return StrictJson.object(readyLine);
        }
        void failure(int seconds) throws Exception { finish(1, seconds); LocalAuthTest.check(readyLine == null, "Invalid startup emitted readiness"); }
        void finish(int status, int seconds) throws Exception {
            LocalAuthTest.check(process.waitFor(seconds, TimeUnit.SECONDS), "Child did not exit within fixture deadline");
            String rest = stdout.lines().collect(java.util.stream.Collectors.joining("\n")); String err = stderr.get(5, TimeUnit.SECONDS);
            noSecrets(rest); noSecrets(err);
            LocalAuthTest.check(process.exitValue() == status, "Child expected exit " + status + ", got " + process.exitValue());
            LocalAuthTest.check(rest.isEmpty(), "Unexpected local stdout (redacted)");
            LocalAuthTest.check(status == 0 ? err.isEmpty() : err.equals("Local engine stopped safely.\n"), "Only fixed redacted diagnostics allowed");
        }
        void noSecrets(String text) { LocalAuthTest.check(!text.contains(CAP) && !text.contains(KEY) && !text.contains("hostile-fixture") && !text.contains("synthetic-password"), "Secret leaked to child output"); }
        public void close() throws Exception { if (process.isAlive()) { process.destroyForcibly(); process.waitFor(5, TimeUnit.SECONDS); } stdout.close(); }
    }
}
