package com.peentar.thriftquery;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** Two real browser sessions and synthetic JDBC: foreign account IDs must never reach JDBC. */
public final class ConnectionOwnershipTest {
    private static final HttpClient CLIENT = HttpClient.newHttpClient();

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-ownership");
        AppConfig config = AppConfig.load(root, Map.of("GITHUB_CLIENT_ID", "fixture", "GITHUB_CLIENT_SECRET", "fixture"));
        List<String> executed = java.util.Collections.synchronizedList(new ArrayList<>());
        AtomicInteger opened = new AtomicInteger();
        ConnectionRegistry.ServiceFactory factory = profile -> new JdbcService(config, profile, () -> {
            opened.incrementAndGet();
            return ConnectionHttpTest.fixture(profile, executed);
        });
        ThriftQueryServer server = server(config, factory);
        try {
            server.start(0);
            String base = "http://127.0.0.1:" + server.port();
            String alice = login(base, "alice"), bob = login(base, "bob");
            String aliceId = JsonUtil.stringField(request(base, "/api/connections/connect", alice, "POST", profile("Alice private", ""), 200), "id");
            String list = request(base, "/api/connections", bob, "GET", null, 200);
            check(!list.contains("Alice private") && !list.contains(aliceId), "Bob must not see Alice's connection");
            check(request(base, "/api/health", bob, "GET", null, 200).contains("\"configured\":false"), "Health must not expose another account's active source");
            int before = opened.get();
            request(base, "/api/connections/" + aliceId, bob, "GET", null, 404);
            request(base, "/api/connections", bob, "POST", profile("Stolen", aliceId), 404);
            request(base, "/api/connections/connect", bob, "POST", profile("Stolen", aliceId), 404);
            request(base, "/api/connections/test", bob, "POST", profile("Stolen", aliceId), 404);
            request(base, "/api/connections/disconnect", bob, "POST", "{\"connectionId\":\"" + aliceId + "\"}", 404);
            request(base, "/api/connections/" + aliceId, bob, "DELETE", null, 404);
            request(base, "/api/query", bob, "POST", query(aliceId), 404);
            request(base, "/api/query", bob, "POST", "{\"sql\":\"DELETE FROM fixture\"}", 503);
            for (String endpoint : List.of("/api/databases?", "/api/namespaces?", "/api/tables?namespace=app&", "/api/columns?namespace=app&table=fixture&")) {
                request(base, endpoint + "connectionId=" + aliceId, bob, "GET", null, 404);
            }
            check(opened.get() == before && executed.isEmpty(), "Foreign operations must be rejected before JDBC opens or executes");
            check(request(base, "/api/connections/" + aliceId, alice, "GET", null, 200).contains("alice-private-secret"), "Owner may edit credentials");
            String bobId = JsonUtil.stringField(request(base, "/api/connections/connect", bob, "POST", profile("Bob private", "").replace("}", ",\"ownerId\":\"1001\"}"), 200), "id");
            check(!request(base, "/api/connections?ownerId=2002", alice, "GET", null, 200).contains(bobId), "Client owner fields and query parameters cannot select another workspace");
            check(request(base, "/api/query", alice, "POST", "{\"sql\":\"SELECT 1 LIMIT 1\"}", 200).contains("Alice private"), "Alice default stays inside her workspace");
            check(request(base, "/api/query", bob, "POST", "{\"sql\":\"SELECT 1 LIMIT 1\"}", 200).contains("Bob private"), "Bob default stays inside his workspace");
            var pending = new ArrayList<java.util.concurrent.CompletableFuture<HttpResponse<String>>>();
            for (int i = 0; i < 32; i++) {
                pending.add(CLIENT.sendAsync(HttpRequest.newBuilder(URI.create(base + "/api/connections"))
                        .header("Cookie", i % 2 == 0 ? alice : bob).GET().build(), HttpResponse.BodyHandlers.ofString()));
            }
            for (int i = 0; i < pending.size(); i++) {
                String body = pending.get(i).join().body();
                check(body.contains(i % 2 == 0 ? aliceId : bobId) && !body.contains(i % 2 == 0 ? bobId : aliceId), "Parallel requests must retain their authenticated account");
            }
            request(base, "/api/connections/" + aliceId, bob, "GET", null, "1001", 409);
            request(base, "/api/query", bob, "POST", query(bobId), "1001", 409);
            String renamed = login(base, "alice-renamed");
            check(request(base, "/api/connections", renamed, "GET", null, 200).contains(aliceId), "Stable GitHub ID preserves ownership after username changes");
            String reused = login(base, "alice-reused");
            check(!request(base, "/api/connections", reused, "GET", null, 200).contains(aliceId), "A reused username cannot inherit a different account's data");
            server.stop();
            server = server(config, factory); server.start(0); base = "http://127.0.0.1:" + server.port();
            alice = login(base, "alice-renamed"); bob = login(base, "bob");
            check(request(base, "/api/connections", alice, "GET", null, 200).contains(aliceId), "Ownership persists across restart");
            check(!request(base, "/api/connections", bob, "GET", null, 200).contains(aliceId), "Restart cannot restore another user's profiles");
            request(base, "/api/connections/" + aliceId, bob, "GET", null, 404);
            check(request(base, "/api/connections/" + aliceId, alice, "GET", null, 200).contains("alice-private-secret"), "Credentials remain available only to owner after restart");
            // Cached workspace still exists, but its persistence volume becomes unavailable.
            try (var db = java.sql.DriverManager.getConnection("jdbc:sqlite:" + config.dataDir.resolve("gridbase.sqlite")); var sql = db.createStatement()) {
                sql.executeUpdate("ALTER TABLE connections RENAME TO unavailable_connections");
            }
            int openedBeforeStorageFailure = opened.get();
            request(base, "/api/connections/test", alice, "POST", profile("Unavailable store", aliceId), 503);
            check(opened.get() == openedBeforeStorageFailure, "Unavailable owner check must fail before JDBC opens");
            System.out.println("GitHub connection ownership HTTP tests passed");
        } finally {
            server.stop();
            try (var files = Files.walk(root)) { for (Path file : files.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(file); }
        }
    }

    private static ThriftQueryServer server(AppConfig config, ConnectionRegistry.ServiceFactory factory) {
        return new ThriftQueryServer(config, new ConnectionWorkspaces(config, factory),
                new GitHubAuth(config.auth, (code, verifier) -> new GitHubAuth.User(code.startsWith("alice") && !code.endsWith("reused") ? "1001" : code.equals("bob") ? "2002" : "3003", code.equals("alice-reused") ? "alice" : code)));
    }
    private static String login(String base, String code) throws Exception {
        var flow = GitHubAuthTest.begin(base);
        HttpResponse<String> response = CLIENT.send(HttpRequest.newBuilder(URI.create(base + "/auth/github/callback?state=" + flow.state() + "&code=" + code))
                .header("Cookie", flow.cookie()).GET().build(), HttpResponse.BodyHandlers.ofString());
        check(response.statusCode() == 303 && response.headers().firstValue("Location").orElse("").equals("/"), "Fixture login must succeed");
        return response.headers().allValues("Set-Cookie").stream().filter(value -> value.startsWith("gridbase_session=")).findFirst().orElseThrow().split(";", 2)[0];
    }
    private static String profile(String name, String id) {
        return "{\"type\":\"postgresql\",\"name\":\"" + name + "\",\"host\":\"fixture\",\"database\":\"app\",\"username\":\"fixture\",\"password\":\"alice-private-secret\""
                + (id.isEmpty() ? "" : ",\"connectionId\":\"" + id + "\"") + "}";
    }
    private static String query(String id) { return "{\"connectionId\":\"" + id + "\",\"sql\":\"DELETE FROM fixture\"}"; }
    private static String request(String base, String path, String cookie, String method, String body, int status) throws Exception {
        return request(base, path, cookie, method, body, null, status);
    }
    private static String request(String base, String path, String cookie, String method, String body, String expectedAccount, int status) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create(base + path)).header("Cookie", cookie);
        if (expectedAccount != null) builder.header("X-GridBase-Account", expectedAccount);
        if (body != null) builder.header("Content-Type", "application/json");
        HttpResponse<String> response = CLIENT.send(builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        check(response.statusCode() == status, method + " " + path + " expected " + status + ", got " + response.statusCode() + ": " + response.body());
        return response.body();
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
