package com.peentar.thriftquery;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** Real HTTP/SQLite with only the remote identity provider and JDBC connection replaced. */
public final class ActivityHttpTest {
    private static final HttpClient CLIENT = HttpClient.newHttpClient();
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-audit-http");
        AppConfig config = AppConfig.load(root, Map.of("GITHUB_CLIENT_ID", "fixture", "GITHUB_CLIENT_SECRET", "fixture", "AUDIT_ADMIN_IDS", "9009"));
        AtomicInteger opened = new AtomicInteger();
        java.util.concurrent.atomic.AtomicBoolean failJdbc = new java.util.concurrent.atomic.AtomicBoolean();
        List<String> executed = java.util.Collections.synchronizedList(new ArrayList<>());
        var factory = (ConnectionRegistry.ServiceFactory) profile -> new JdbcService(config, profile, () -> {
            opened.incrementAndGet();
            if (failJdbc.get()) throw new java.sql.SQLException("raw_error_secret sensitive_sql_literal");
            return ConnectionHttpTest.fixture(profile, executed);
        });
        ThriftQueryServer server = server(config, factory);
        try {
            server.start(0); String base = "http://127.0.0.1:" + server.port();
            String alice = login(base, "alice"), bob = login(base, "bob"), admin = login(base, "admin");
            var own = request(base, "/api/activity", alice, "GET", null, 200);
            check(own.body().contains("auth.login") && own.body().contains("\"userId\":\"1001\""), "Login must be persisted for its verified user");
            check(!own.body().contains("\"userId\":\"2002\""), "Own history cannot include another actor");
            check(request(base, "/api/auth/session", admin, "GET", null, 200).body().contains("\"auditAdmin\":true"), "Admin capability comes from ID config");
            check(request(base, "/api/auth/session", alice, "GET", null, 200).body().contains("\"auditAdmin\":false"), "Ordinary user has no admin capability");
            request(base, "/api/activity?scope=all", alice, "GET", null, 403);
            request(base, "/api/activity?userId=2002", alice, "GET", null, 403);
            request(base, "/api/activity/users", bob, "GET", null, 403);
            request(base, "/api/activity?cursor=0", admin, "GET", null, 400);
            request(base, "/api/activity?from=invalid", alice, "GET", null, 400);
            request(base, "/api/activity?from=2026-11-14T12:00:00%2B01:00", alice, "GET", null, 400);
            request(base, "/api/activity?ownerId=2002", alice, "GET", null, 400);
            request(base, "/auth/github/callback?state=unverified&code=oauth-secret", "", "GET", null, 303);
            check(request(base, "/api/activity?scope=all&action=auth.login&outcome=failure", admin, "GET", null, 200).body().contains("\"userId\":null"), "Unverified failure remains anonymous");
            request(base, "/api/activity", "", "GET", null, 401);
            var stale = CLIENT.send(HttpRequest.newBuilder(URI.create(base + "/api/activity")).header("Cookie", alice).header("X-GridBase-Account", "2002").GET().build(), HttpResponse.BodyHandlers.ofString());
            check(stale.statusCode() == 409 && !stale.body().contains("auth.login"), "Stale account cannot read logs");
            var csrf = CLIENT.send(HttpRequest.newBuilder(URI.create(base + "/api/activity/exports")).header("Cookie", alice).header("Origin", "https://evil.example").header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString("{}")).build(), HttpResponse.BodyHandlers.ofString());
            check(csrf.statusCode() == 403, "Export retains CSRF guard");
            for (String reserved : List.of("test", "connect", "disconnect")) {
                request(base, "/api/connections", alice, "POST", profile("Reserved", reserved), 200);
                request(base, "/api/connections/" + reserved, alice, "GET", null, 200);
                request(base, "/api/connections/" + reserved, alice, "DELETE", null, 200);
                var persisted = new AuditStore(config.dataDir);
                check(persisted.list("1001", false, Map.of("connectionId", reserved, "action", "connection.details")).events().size() == 1, "Reserved ID details attributed to actual GET: " + reserved);
                check(persisted.list("1001", false, Map.of("connectionId", reserved, "action", "connection.delete")).events().size() == 1, "Reserved ID deletion attributed to actual DELETE: " + reserved);
            }
            String aliceConnection = JsonUtil.stringField(request(base, "/api/connections/connect", alice, "POST", profile("Alice", ""), 200).body(), "id");
            String bobConnection = JsonUtil.stringField(request(base, "/api/connections/connect", bob, "POST", profile("Bob", ""), 200).body(), "id");
            String sql = "SELECT 'sensitive_sql_literal' LIMIT 1";
            var result = request(base, "/api/query", alice, "POST", "{\"sql\":" + JsonUtil.quote(sql) + ",\"connectionId\":" + JsonUtil.quote(aliceConnection) + "}", 200);
            String queryId = JsonUtil.stringField(result.body(), "requestId");
            check(queryId.equals(result.headers().firstValue("X-Request-ID").orElse("")), "Query response correlates with server-generated request ID");
            request(base, "/api/query", bob, "POST", "{\"sql\":\"SELECT 1 LIMIT 1\",\"connectionId\":" + JsonUtil.quote(bobConnection) + "}", 200);
            request(base, "/api/tables?namespace=app&connectionId=" + aliceConnection, alice, "GET", null, 200);
            request(base, "/api/query", bob, "POST", "{\"sql\":\"DELETE FROM fixture\",\"connectionId\":" + JsonUtil.quote(aliceConnection) + "}", 404);
            request(base, "/api/databases?connectionId=" + aliceConnection, alice, "GET", null, 200);
            request(base, "/api/namespaces?connectionId=" + aliceConnection, alice, "GET", null, 200);
            request(base, "/api/columns?namespace=app&table=fixture&connectionId=" + aliceConnection, alice, "GET", null, 200);
            request(base, "/api/connections", alice, "GET", null, 200);
            request(base, "/api/connections/test", alice, "POST", profile("Test", aliceConnection), 200);
            request(base, "/api/connections/test", alice, "POST", profile("broken", ""), 502);
            request(base, "/api/connections/" + aliceConnection, alice, "GET", null, 200);
            String saved = JsonUtil.stringField(request(base, "/api/connections", alice, "POST", profile("Saved", ""), 200).body(), "id");
            request(base, "/api/connections", alice, "POST", profile("Edited", saved), 200);
            request(base, "/api/connections/connect", alice, "POST", profile("Reconnected", saved), 200);
            request(base, "/api/connections/disconnect", alice, "POST", "{\"connectionId\":" + JsonUtil.quote(saved) + "}", 200);
            String update = request(base, "/api/query", alice, "POST", "{\"sql\":\"UPDATE fixture SET id=2\",\"connectionId\":" + JsonUtil.quote(aliceConnection) + "}", 200).body();
            check(request(base, "/api/activity?action=query.execute", alice, "GET", null, 200).body().contains("\"affectedRows\":1"), "Affected count captured");
            request(base, "/api/query", alice, "POST", "{\"sql\":\"\"}", 422);
            failJdbc.set(true);
            String failedId = request(base, "/api/query", alice, "POST", "{\"sql\":\"SELECT 1 LIMIT 1\",\"connectionId\":" + JsonUtil.quote(aliceConnection) + "}", 502).headers().firstValue("X-Request-ID").orElseThrow();
            failJdbc.set(false);
            request(base, "/api/activity/exports", alice, "POST", "{\"queryRequestId\":" + JsonUtil.quote(failedId) + ",\"format\":\"csv\",\"rowCount\":0}", 404);
            int before = opened.get();
            request(base, "/api/query-extra", bob, "POST", "{\"sql\":\"DELETE FROM fixture\"}", 404);
            for (String path : List.of("/api/databases-extra", "/api/namespaces/", "/api/tables-extra", "/api/columns/", "/api/health-extra")) request(base, path, alice, "GET", null, 404);
            request(base, "/api/query", alice, "GET", null, 405);
            check(opened.get() == before, "Suffix routes and unsupported methods must not execute unaudited JDBC");
            List<java.util.concurrent.CompletableFuture<HttpResponse<String>>> parallel = new ArrayList<>();
            for (int i = 0; i < 12; i++) parallel.add(CLIENT.sendAsync(HttpRequest.newBuilder(URI.create(base + "/api/query")).header("Cookie", i % 2 == 0 ? alice : bob).header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString("{\"sql\":\"SELECT 1 LIMIT 1\"}")).build(), HttpResponse.BodyHandlers.ofString()));
            for (int i = 0; i < parallel.size(); i++) {
                var response = parallel.get(i).join(); check(response.statusCode() == 200, "Parallel query succeeds");
                String id = JsonUtil.stringField(response.body(), "requestId");
                try (var db = java.sql.DriverManager.getConnection("jdbc:sqlite:" + config.dataDir.resolve("audit.sqlite")); var statement = db.prepareStatement("SELECT user_id FROM audit_events WHERE request_id=?")) {
                    statement.setString(1, id); try (var rows = statement.executeQuery()) { check(rows.next() && rows.getString(1).equals(i % 2 == 0 ? "1001" : "2002"), "Parallel actor attribution remains request-local"); }
                }
            }
            sql(config, "CREATE TRIGGER fail_finish BEFORE UPDATE ON audit_events WHEN NEW.outcome <> 'pending' BEGIN SELECT RAISE(FAIL, 'fixture'); END");
            var incomplete = request(base, "/api/query", alice, "POST", "{\"sql\":\"SELECT 1 LIMIT 1\",\"connectionId\":" + JsonUtil.quote(aliceConnection) + "}", 200);
            check(incomplete.headers().firstValue("X-GridBase-Audit-Warning").orElse("").equals("incomplete"), "Completion failure preserves successful SQL with warning");
            String incompleteId = JsonUtil.stringField(incomplete.body(), "requestId");
            check(new AuditStore(config.dataDir).list("1001", false, Map.of("outcome", "pending")).toJson().contains(incompleteId), "Durable intent remains pending");
            sql(config, "DROP TRIGGER fail_finish");
            sql(config, "CREATE TRIGGER fail_annotate BEFORE UPDATE ON audit_events WHEN NEW.outcome = 'pending' BEGIN SELECT RAISE(FAIL, 'fixture'); END");
            before = opened.get();
            request(base, "/api/query", alice, "POST", "{\"sql\":\"DELETE FROM fixture\"}", 503);
            check(opened.get() == before, "Failed target annotation prevents JDBC");
            sql(config, "DROP TRIGGER fail_annotate");
            sql(config, "CREATE TRIGGER fail_begin BEFORE INSERT ON audit_events BEGIN SELECT RAISE(FAIL, 'fixture'); END");
            before = opened.get();
            request(base, "/api/query", alice, "POST", "{\"sql\":\"DELETE FROM fixture\"}", 503);
            request(base, "/api/connections/connect", alice, "POST", profile("Blocked", ""), 503);
            request(base, "/api/tables?namespace=app", alice, "GET", null, 503);
            check(opened.get() == before, "Failed durable intent prevents all JDBC");
            String revoke = login(base, "alice");
            request(base, "/auth/logout", revoke, "POST", "{}", 200);
            request(base, "/api/activity", revoke, "GET", null, 401);
            sql(config, "DROP TRIGGER fail_begin");
            long count = auditCount(config);
            request(base, "/api/auth/session", alice, "GET", null, 200);
            request(base, "/api/health", alice, "GET", null, 200);
            request(base, "/healthz", "", "GET", null, 200);
            request(base, "/api/activity", alice, "GET", null, 200);
            check(auditCount(config) == count, "Polling and audit reads are excluded");
            String logout = login(base, "bob");
            request(base, "/auth/logout", logout, "POST", "{}", 200);
            check(request(base, "/api/activity?action=auth.logout", bob, "GET", null, 200).body().contains("\"outcome\":\"success\""), "Logout attributed before revocation");
            var audit = request(base, "/api/activity?action=query.execute", alice, "GET", null, 200).body();
            check(audit.contains(queryId) && audit.contains("\"sqlOperation\":\"SELECT\"") && audit.contains("\"returnedRows\":1"), "Query metadata and counts recorded");
            check(!audit.contains("sensitive_sql_literal") && !audit.contains("alice-private-password"), "Audit API never exposes SQL text or credentials");
            request(base, "/api/connections/" + aliceConnection, alice, "DELETE", null, 200);
            String export = "{\"queryRequestId\":" + JsonUtil.quote(queryId) + ",\"format\":\"csv\",\"rowCount\":1,\"userId\":\"2002\",\"source\":\"server\"}";
            request(base, "/api/activity/exports", alice, "POST", export, 200);
            request(base, "/api/activity/exports", bob, "POST", export, 404);
            request(base, "/api/activity/exports", alice, "POST", export.replace("\"rowCount\":1", "\"rowCount\":2"), 400);
            request(base, "/api/activity/exports", alice, "POST", export.replace("\"rowCount\":1", "\"rowCount\":0"), 200);
            for (String invalidCount : List.of("-1", "1.1", "\"1\"", "null", "9223372036854775808")) request(base, "/api/activity/exports", alice, "POST", export.replace("\"rowCount\":1", "\"rowCount\":" + invalidCount), 400);
            request(base, "/api/activity/exports", alice, "POST", export.replace("csv", "pdf"), 400);
            request(base, "/api/activity/exports", alice, "POST", export.replace(queryId, "11111111-1111-4111-8111-111111111111"), 404);
            String exports = request(base, "/api/activity?action=result.export_requested", alice, "GET", null, 200).body();
            check(exports.contains("\"source\":\"browser\"") && exports.contains("\"userId\":\"1001\""), "Browser cannot forge source or actor");
            check(request(base, "/api/activity?scope=all", admin, "GET", null, 200).body().contains("\"userId\":\"2002\""), "Admin can inspect all actor metadata");
            request(base, "/api/connections/" + bobConnection, admin, "GET", null, 404);
            String next = JsonUtil.stringField(request(base, "/api/activity?scope=all&limit=1", admin, "GET", null, 200).body(), "nextCursor");
            request(base, "/api/activity?scope=all&limit=1&cursor=" + next, admin, "GET", null, 200);
            check(request(base, "/api/activity/users", admin, "GET", null, 200).body().contains("alice"), "Admin actor choices available");
            String allActions = request(base, "/api/activity?limit=100", alice, "GET", null, 200).body();
            for (String expected : List.of("connection.list","connection.save","connection.details","connection.test","connection.connect","connection.disconnect","connection.delete","query.execute","metadata.databases","metadata.namespaces","metadata.tables","metadata.columns")) check(allActions.contains(expected), "Operational action persisted: " + expected);
            String renamed = login(base, "alice-renamed");
            check(request(base, "/api/activity", renamed, "GET", null, 200).body().contains(queryId), "Renamed identity keeps audit ownership");
            String reused = login(base, "alice-reused");
            check(!request(base, "/api/activity", reused, "GET", null, 200).body().contains(queryId), "Reused login cannot inherit activity");
            StringBuilder diskBytes = new StringBuilder();
            try (var files = Files.list(config.dataDir)) { for (var file : files.filter(f -> f.getFileName().toString().startsWith("audit.sqlite")).toList()) diskBytes.append(new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1)); }
            String disk = diskBytes.toString();
            check(!disk.contains("sensitive_sql_literal") && !disk.contains("alice-private-password") && !disk.contains("jdbc:postgresql") && !disk.contains("raw_error_secret") && !disk.contains("oauth-secret"), "Sensitive payloads absent on disk");
            server.stop(); server = server(config, factory); server.start(0); base = "http://127.0.0.1:" + server.port();
            alice = login(base, "alice-renamed");
            check(request(base, "/api/activity", alice, "GET", null, 200).body().contains(queryId), "Audit persists after restart");
            Path profiles = config.dataDir.resolve("gridbase.sqlite"), held = config.dataDir.resolve("profiles-held.sqlite");
            Files.move(profiles, held); Files.createDirectory(profiles);
            try {
                request(base, "/api/connections", alice, "GET", null, 503);
                check(request(base, "/api/activity", alice, "GET", null, 200).body().contains(queryId), "Audit remains readable when profile registry is unavailable");
            } finally { Files.delete(profiles); Files.move(held, profiles); }
            authFailures();
            System.out.println("User activity audit HTTP tests passed");
        } finally {
            server.stop(); try (var files = Files.walk(root)) { for (var file : files.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(file); }
        }
    }
    private static void authFailures() throws Exception {
        Path root = Files.createTempDirectory("gridbase-audit-denied");
        AppConfig config = AppConfig.load(root, Map.of("GITHUB_CLIENT_ID", "fixture", "GITHUB_CLIENT_SECRET", "fixture", "GITHUB_ALLOWED_USERS", "alice"));
        var auth = new GitHubAuth(config.auth, (code, verifier) -> {
            if (code.equals("failed")) throw new java.io.IOException("provider-secret");
            return new GitHubAuth.User("2002", "bob");
        });
        var server = new ThriftQueryServer(config, new ConnectionWorkspaces(config), auth);
        try {
            server.start(0); String base = "http://127.0.0.1:" + server.port();
            for (String code : List.of("bob", "failed")) {
                var flow = GitHubAuthTest.begin(base);
                request(base, "/auth/github/callback?state=" + flow.state() + "&code=" + code, flow.cookie(), "GET", null, 303);
            }
            String records = new AuditStore(config.dataDir).list("9009", true, Map.of("scope", "all", "action", "auth.login")).toJson();
            check(records.contains("\"userId\":\"2002\"") && records.contains("AUTH_NOT_ALLOWED") && records.contains("\"userId\":null") && records.contains("AUTH_FAILED"), "Verified denied account retained, failed verification anonymous");
            check(!records.contains("provider-secret"), "Provider error content is excluded");
        } finally {
            server.stop(); try (var files = Files.walk(root)) { for (var file : files.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(file); }
        }
    }
    private static void sql(AppConfig config, String statement) throws Exception {
        try (var db = java.sql.DriverManager.getConnection("jdbc:sqlite:" + config.dataDir.resolve("audit.sqlite")); var sql = db.createStatement()) { sql.execute(statement); }
    }
    private static long auditCount(AppConfig config) throws Exception {
        try (var db = java.sql.DriverManager.getConnection("jdbc:sqlite:" + config.dataDir.resolve("audit.sqlite")); var sql = db.createStatement(); var rows = sql.executeQuery("SELECT COUNT(*) FROM audit_events")) { rows.next(); return rows.getLong(1); }
    }
    private static ThriftQueryServer server(AppConfig config, ConnectionRegistry.ServiceFactory factory) {
        return new ThriftQueryServer(config, new ConnectionWorkspaces(config, factory), new GitHubAuth(config.auth, (code, verifier) ->
                new GitHubAuth.User(code.equals("admin") ? "9009" : code.equals("bob") ? "2002" : code.equals("alice-reused") ? "3003" : "1001", code.equals("alice-reused") ? "alice" : code)));
    }
    private static String profile(String name, String id) {
        return "{\"type\":\"postgresql\",\"name\":" + JsonUtil.quote(name) + ",\"host\":\"fixture\",\"database\":\"app\",\"username\":\"fixture\",\"password\":\"alice-private-password\"" + (id.isEmpty() ? "" : ",\"connectionId\":" + JsonUtil.quote(id)) + "}";
    }
    private static String login(String base, String code) throws Exception {
        var flow = GitHubAuthTest.begin(base);
        var response = CLIENT.send(HttpRequest.newBuilder(URI.create(base + "/auth/github/callback?state=" + flow.state() + "&code=" + code)).header("Cookie", flow.cookie()).GET().build(), HttpResponse.BodyHandlers.ofString());
        check(response.statusCode() == 303 && response.headers().firstValue("Location").orElse("").equals("/"), "Fixture login succeeds");
        return response.headers().allValues("Set-Cookie").stream().filter(v -> v.startsWith("gridbase_session=")).findFirst().orElseThrow().split(";", 2)[0];
    }
    private static HttpResponse<String> request(String base, String path, String cookie, String method, String body, int status) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create(base + path)).header("Cookie", cookie).timeout(java.time.Duration.ofSeconds(15));
        if (body != null) builder.header("Content-Type", "application/json");
        var response = CLIENT.send(builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        check(response.statusCode() == status, method + " " + path + " expected " + status + ", got " + response.statusCode() + ": " + response.body()); return response;
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
