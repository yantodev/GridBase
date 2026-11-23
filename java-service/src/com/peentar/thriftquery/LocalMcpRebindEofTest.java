package com.peentar.thriftquery;

import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Actual local engine: pending replacement socket must close on EOF before old JDBC exits. */
public final class LocalMcpRebindEofTest {
    private static int assertions;
    private static void check(boolean value, String message) { assertions++; LocalAuthTest.check(value, message); }
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("task4-fix1-rebind-eof 空 間");
        LocalEngineProcessTest.root = root;
        try {
            Path fixture = LocalEngineProcessTest.fixture("combined");
            driver(fixture);
            try (LocalEngineProcessTest.Child child = LocalEngineProcessTest.launch(fixture, LocalEngineProcessTest.normalArgs(fixture), 1)) {
                try {
                    child.write(LocalEngineProcessTest.BOOT);
                    String base = "http://127.0.0.1:" + child.ready().get("port").getAsInt();
                    LocalEngineHttpTest.post(base, "/api/connections", LocalEngineHttpTest.PROFILE.replace("saved", "sdk-fixture"), 200);
                    String secret = JsonUtil.stringField(LocalMcpTest.token(base, "full_access", 201), "secret");
                    int oldPort = LocalMcpTest.port(), candidatePort = LocalMcpTest.port();
                    while (candidatePort == oldPort) candidatePort = LocalMcpTest.port();
                    String oldEndpoint = JsonUtil.stringField(LocalMcpTest.put(base, "{\"enabled\":true,\"port\":" + oldPort + "}", 200), "endpoint");
                    String candidateEndpoint = "http://127.0.0.1:" + candidatePort + "/mcp";
                    String write = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"execute_query\",\"arguments\":{\"connectionId\":\"sdk-fixture\",\"sql\":\"UPDATE fixture SET x=2\"}}}";
                    var query = LocalAuthTest.CLIENT.sendAsync(LocalMcpTest.rpc(oldEndpoint, "Bearer " + secret, write).build(), HttpResponse.BodyHandlers.ofString());
                    awaitMarker(fixture.resolve("jdbc-entered"), "execute\n", child.process);
                    var rebind = LocalAuthTest.CLIENT.sendAsync(LocalAuthTest.valid(base, "/api/local/mcp").header("Content-Type", "application/json")
                            .PUT(HttpRequest.BodyPublishers.ofString("{\"enabled\":true,\"port\":" + candidatePort + "}")).build(), HttpResponse.BodyHandlers.ofString());
                    awaitCandidate(candidateEndpoint, secret, child.process);
                    // Even an authenticated business request to the inactive candidate must not enter JDBC.
                    var pending = LocalAuthTest.expect(LocalMcpTest.rpc(candidateEndpoint, "Bearer " + secret, write), 503);
                    check(StrictJson.object(pending.body()).get("code").getAsString().equals("MCP_TRANSITION"), "Owned candidate is bound but inactive");
                    awaitMarker(fixture.resolve("mcp-interrupted"), "interrupted", child.process);
                    check(Files.readAllLines(fixture.resolve("jdbc-entered")).size() == 1, "No candidate pool execution/write retry before EOF");
                    child.process.getOutputStream().close();
                    awaitClosed(base + "/healthz", child.process, "Native API did not stop after EOF");
                    awaitClosed(oldEndpoint, child.process, "Old MCP listener did not close after EOF");
                    awaitClosed(candidateEndpoint, child.process, "Pending MCP candidate remains accepting after stdin EOF while old JDBC is blocked");
                    check(child.process.isAlive(), "EOF waits for true old JDBC termination");
                    try (LocalEngineProcessTest.Child contender = LocalEngineProcessTest.launch(fixture, LocalEngineProcessTest.normalArgs(fixture), 1)) {
                        contender.write(LocalEngineProcessTest.BOOT); contender.failure(15);
                    }
                    check(child.process.isAlive(), "Local workspace remains owned after contender refusal");
                    check(Files.readAllLines(fixture.resolve("jdbc-entered")).size() == 1, "Uncertain write never retried during shutdown/rebind");
                    Files.writeString(fixture.resolve("jdbc-release"), "release", StandardOpenOption.CREATE_NEW);
                    child.finish(0, 15);
                    finishRequest(query); finishRequest(rebind);
                    absentAfterExit(candidateEndpoint);
                    try (LocalWorkspace ignored = LocalWorkspace.open(fixture.resolve("data"), new CredentialKey(LocalEngineProcessTest.keyBytes()))) { assertions++; }
                    check(LocalEngineProcessTest.processes == 2, "Actual engine and locked contender JVM counts");
                    System.out.println("Local MCP rebind+EOF passed (" + assertions + " assertions; 2 actual child JVMs; both MCP ports closed while JDBC blocked; lock retained; normal exit after release)");
                } finally {
                    // Owned child cleanup remains bounded even on the expected pre-fix RED.
                    if (child.process.isAlive() && !Files.exists(fixture.resolve("jdbc-release"))) Files.writeString(fixture.resolve("jdbc-release"), "release");
                    if (child.process.isAlive()) child.process.waitFor(5, TimeUnit.SECONDS);
                }
            }
            concurrentClose(root.resolve("in-process"));
        } finally { PrivateFilesTest.remove(root); }
    }
    private static void concurrentClose(Path root) throws Exception {
        AppConfig config = LocalMcpTest.config(root);
        CountDownLatch entered = new CountDownLatch(1), interrupted = new CountDownLatch(1), release = new CountDownLatch(1);
        java.util.concurrent.atomic.AtomicInteger jdbc = new java.util.concurrent.atomic.AtomicInteger();
        ExecutorService transitions = Executors.newCachedThreadPool();
        try (LocalWorkspace workspace = LocalWorkspace.open(config.dataDir, new CredentialKey(LocalEngineProcessTest.keyBytes()))) {
            var stores = new ConnectionWorkspaces(config, workspace, profile -> new JdbcService(config, profile, () -> {
                jdbc.incrementAndGet(); entered.countDown();
                while (release.getCount() != 0) try { release.await(); } catch (InterruptedException ignored) { interrupted.countDown(); }
                throw new java.sql.SQLException("Synthetic unknown outcome");
            }));
            var control = new LocalMcpTest.Control(config, stores, workspace);
            try {
                var registry = stores.forOwner(workspace.actor()); registry.save("sdk-fixture", ConnectionSettings.fromJson(LocalMcpTest.PROFILE.replace("true", "false")));
                var profile = registry.mcp("sdk-fixture");
                var token = new McpTokenStore(config.dataDir).create(workspace.actor(), "close-race", "full_access", 30, List.of(new McpTokenStore.Grant(profile.id(), profile.generation(), false)));
                control.start(); control.set(true, LocalMcpTest.port()); String old = control.endpoint();
                String body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"execute_query\",\"arguments\":{\"connectionId\":\"sdk-fixture\",\"sql\":\"UPDATE fixture SET x=2\"}}}";
                var query = LocalAuthTest.CLIENT.sendAsync(LocalMcpTest.rpc(old, "Bearer " + token.secret(), body).build(), HttpResponse.BodyHandlers.ofString());
                check(entered.await(5, TimeUnit.SECONDS), "In-process old JDBC entered");
                int port = LocalMcpTest.port(); String candidate = "http://127.0.0.1:" + port + "/mcp";
                Future<Boolean> rebind = transitions.submit(() -> { try { control.set(true, port); return false; } catch (IOException stopped) { return true; } });
                awaitCandidate(candidate, token.secret(), null);
                check(interrupted.await(5, TimeUnit.SECONDS), "In-process old worker cancellation observed");
                Future<?> close1 = transitions.submit(() -> { try { control.close(); } catch (Exception failure) { throw new CompletionException(failure); } });
                awaitClosed(old, null, "In-process old socket survived close");
                awaitClosed(candidate, null, "In-process pending candidate survived close");
                Future<?> close2 = transitions.submit(() -> { try { control.close(); } catch (Exception failure) { throw new CompletionException(failure); } });
                Future<Boolean> afterClose = transitions.submit(() -> { try { control.set(true, port); return false; } catch (IOException stopped) { return true; } });
                check(afterClose.get(5, TimeUnit.SECONDS), "Transition after close cannot bind or activate");
                check(!close1.isDone() && !close2.isDone(), "Every concurrent close waits for actual old JDBC completion");
                check(!control.enabled() && control.endpoint() == null && jdbc.get() == 1, "No live endpoint/replacement capacity while closing");
                release.countDown(); close1.get(10, TimeUnit.SECONDS); close2.get(10, TimeUnit.SECONDS);
                check(rebind.get(10, TimeUnit.SECONDS), "Pending transition acknowledges shutdown, never publishes candidate");
                finishRequest(query); control.close(); absentAfterExit(candidate);
                check(jdbc.get() == 1, "Concurrent close did not retry the uncertain write");
                System.out.println("Local MCP pending rebind/concurrent repeated-close race passed; no resurrection or early close return");
            } finally { release.countDown(); control.close(); }
        } finally { release.countDown(); transitions.shutdownNow(); }
    }
    private static void driver(Path fixture) throws Exception {
        Path classes = fixture.resolve("test-driver-classes"), source = fixture.resolve("Driver.java"); Files.createDirectory(classes);
        Files.writeString(source, """
                package org.postgresql;
                public class Driver implements java.sql.Driver {
                    static { try { java.sql.DriverManager.registerDriver(new Driver()); } catch (Exception e) { throw new ExceptionInInitializerError(e); } }
                    public java.sql.Connection connect(String url, java.util.Properties p) throws java.sql.SQLException {
                        return acceptsURL(url) ? com.peentar.thriftquery.LocalMcpTest.childJdbc() : null;
                    }
                    public boolean acceptsURL(String url) { return url.startsWith("jdbc:postgresql:"); }
                    public java.sql.DriverPropertyInfo[] getPropertyInfo(String u, java.util.Properties p) { return new java.sql.DriverPropertyInfo[0]; }
                    public int getMajorVersion() { return 1; }
                    public int getMinorVersion() { return 0; }
                    public boolean jdbcCompliant() { return false; }
                    public java.util.logging.Logger getParentLogger() { return java.util.logging.Logger.getGlobal(); }
                }
                """);
        int status = javax.tools.ToolProvider.getSystemJavaCompiler().run(null, System.out, System.err, "--release", "17", "-cp", System.getProperty("java.class.path"), "-d", classes.toString(), source.toString());
        check(status == 0, "Isolated child-JVM JDBC fixture compiled");
    }
    private static void awaitMarker(Path marker, String expected, Process process) throws Exception {
        LocalEngineProcessTest.awaitFile(marker, process);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (true) {
            if (Files.readString(marker).equals(expected)) { assertions++; return; }
            check(process.isAlive() && System.nanoTime() < deadline, "Fixture marker contents invalid or incomplete");
            Thread.sleep(5);
        }
    }
    private static void awaitCandidate(String endpoint, String secret, Process process) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            check(process == null || process.isAlive(), "Engine exited before pending candidate bind");
            try {
                var response = LocalAuthTest.CLIENT.send(LocalMcpTest.rpc(endpoint, "Bearer " + secret, LocalMcpTest.PING).timeout(java.time.Duration.ofSeconds(1)).build(), HttpResponse.BodyHandlers.ofString());
                check(response.statusCode() == 503 && StrictJson.object(response.body()).get("code").getAsString().equals("MCP_TRANSITION"), "Candidate HTTP must be inactive typed503, never active");
                return;
            } catch (ConnectException notBoundYet) { Thread.sleep(5); }
        }
        throw new AssertionError("Pending candidate did not bind before guarded deadline");
    }
    @FunctionalInterface
    interface SocketConnector {
        void connect(Socket socket, SocketAddress address, int timeoutMillis) throws IOException;
    }
    private static void awaitClosed(String endpoint, Process process, String reason) throws Exception {
        awaitClosed(endpoint, process, reason, Socket::connect, TimeUnit.SECONDS.toNanos(3));
    }
    static void awaitClosed(String endpoint, Process process, String reason, SocketConnector connector, long budgetNanos) throws Exception {
        observeClosed(endpoint, process, reason, connector, budgetNanos, false);
    }
    private static void absentAfterExit(String endpoint) throws Exception {
        absentAfterExit(endpoint, Socket::connect, TimeUnit.SECONDS.toNanos(3));
    }
    static void absentAfterExit(String endpoint, SocketConnector connector, long budgetNanos) throws Exception {
        observeClosed(endpoint, null, "Candidate resurrected after shutdown", connector, budgetNanos, true);
    }
    private static void observeClosed(String endpoint, Process process, String reason, SocketConnector connector, long budgetNanos, boolean afterExit) throws Exception {
        InetSocketAddress address = new InetSocketAddress("127.0.0.1", URI.create(endpoint).getPort());
        long deadline = System.nanoTime() + budgetNanos;
        IOException lastReset = null;
        int resets = 0, accepting = 0;
        while (System.nanoTime() < deadline) {
            check(process == null || process.isAlive(), "Engine exited before JDBC fixture release");
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) break;
            int timeoutMillis = (int) Math.min(250, 1 + (remaining - 1) / 1_000_000);
            boolean refused = false, connected = false;
            try (Socket socket = new Socket()) {
                connector.connect(socket, address, timeoutMillis);
                connected = true;
            } catch (ConnectException failure) {
                // ConnectException is only typically refusal; other connect errors prove nothing.
                if (!"Connection refused".equals(failure.getMessage()) && !"Connection refused: connect".equals(failure.getMessage()))
                    throw closureFailure(reason, endpoint, "connect failed without explicit refusal", failure);
                refused = true;
            } catch (IOException failure) {
                // Linux/JDK 17 exposes ECONNRESET as SocketException text, not a typed errno.
                // Only these known reset outcomes merit another observation; never closure success.
                if (failure instanceof SocketException && ("Connection reset by peer".equals(failure.getMessage())
                        || "Connection reset".equals(failure.getMessage()))) {
                    lastReset = failure; resets++;
                } else throw closureFailure(reason, endpoint, "unexpected connect I/O", failure);
            }
            check(process == null || process.isAlive(), "Engine exited before JDBC fixture release");
            if (refused) { assertions++; return; }
            if (connected) {
                accepting++;
                if (afterExit) throw closureFailure(reason, endpoint, "listener accepted a connection", null);
            }
            remaining = deadline - System.nanoTime();
            if (remaining > 0) TimeUnit.NANOSECONDS.sleep(Math.min(TimeUnit.MILLISECONDS.toNanos(5), remaining));
        }
        throw closureFailure(reason, endpoint, "deadline expired without connection refusal (resets=" + resets + ", accepting=" + accepting + ")", lastReset);
    }
    private static AssertionError closureFailure(String reason, String endpoint, String detail, IOException cause) {
        return new AssertionError(reason + " [" + endpoint + "]: closure not proven; " + detail, cause);
    }
    private static void finishRequest(CompletableFuture<HttpResponse<String>> request) throws Exception {
        try { request.get(10, TimeUnit.SECONDS); } catch (ExecutionException expected) { /* Closed response is unknown; never retry business SQL. */ }
    }
}
