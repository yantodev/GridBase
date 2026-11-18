package com.peentar.thriftquery;

import java.net.http.*;
import java.nio.file.*;
import java.sql.*;
import java.util.*;

/** Real local HTTP + SQLite stores, with only external JDBC replaced by a synthetic fixture. */
public final class LocalEngineHttpTest {
    static final String CAP = LocalAuthTest.CAP;
    static final String PROFILE = "{\"connectionId\":\"saved\",\"name\":\"Local fixture\",\"type\":\"postgresql\",\"host\":\"fixture.invalid\",\"database\":\"app\",\"username\":\"fixture\",\"password\":\"synthetic-password\",\"ownerId\":\"1001\"}";
    static ConnectionWorkspaces workspaces(AppConfig config, LocalWorkspace workspace, ConnectionRegistry.ServiceFactory factory) throws Exception {
        try { return ConnectionWorkspaces.class.getDeclaredConstructor(AppConfig.class, LocalWorkspace.class, ConnectionRegistry.ServiceFactory.class).newInstance(config, workspace, factory); }
        catch (NoSuchMethodException missing) { throw new AssertionError("Local HTTP synthetic-JDBC injection is not implemented", missing); }
    }
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-local-http 空 間");
        try {
            for (String kind : List.of("desktop", "vscode")) exercise(root.resolve(kind), kind);
            serverBoundary(root.resolve("server"));
            System.out.println("Local engine HTTP tests passed (desktop/vscode, synthetic JDBC, real stores, audit and server boundary)");
        } finally { PrivateFilesTest.remove(root); }
    }
    static void exercise(Path root, String kind) throws Exception {
        Files.createDirectories(root.resolve("resources/public"));
        Files.writeString(root.resolve("resources/public/index.html"), "MUST NOT SERVE");
        AppConfig config = AppConfig.local(root.resolve("resources"), root.resolve("data"), root.resolve("temp"), kind);
        try (LocalWorkspace workspace = LocalWorkspace.open(config.dataDir, new CredentialKey(new byte[32]))) {
            List<String> executed = Collections.synchronizedList(new ArrayList<>());
            boolean[] fail = {false}, inspectPending = {false};
            ConnectionRegistry.ServiceFactory factory = profile -> new JdbcService(config, profile, () -> {
                if (inspectPending[0]) {
                    var pending = new AuditStore(config.dataDir).list(workspace.actor().ownerKey(), false, Map.of()).events();
                    LocalAuthTest.check(pending.stream().anyMatch(e -> e.action.equals("query.execute") && e.outcome.equals("pending") && e.sqlText != null), "Audit intent persisted before external JDBC");
                }
                if (fail[0]) { executed.add("uncertain-write"); throw new SQLException("synthetic uncertain outcome"); }
                return ConnectionHttpTest.fixture(profile, executed);
            });
            ConnectionWorkspaces stores = workspaces(config, workspace, factory);
            LocalAuth auth = new LocalAuth(new byte[32], workspace.actor());
            // No arbitrary RequestAuth or GitHub session adapter can enable local mode.
            RequestAuth bypass = new RequestAuth() {
                public Actor actor(com.sun.net.httpserver.HttpExchange e) { return workspace.actor(); }
                public boolean handle(com.sun.net.httpserver.HttpExchange e, Set<String> admins) { return false; }
            };
            rejected(() -> new ThriftQueryServer(config, stores, bypass));
            rejected(() -> new ThriftQueryServer(config, stores, new LocalAuth(new byte[32], LocalAuthTest.OWNER)));
            ThriftQueryServer server = new ThriftQueryServer(config, stores, auth);
            try {
                var host = AppConfig.class.getDeclaredField("host"); host.setAccessible(true); host.set(config, "0.0.0.0");
                rejectedStart(server);
                host.set(config, "127.0.0.1");
                server.start(0);
                String base = "http://127.0.0.1:" + server.port();
                String cookie = "gridbase_session=1001";
                LocalAuthTest.expect(LocalAuthTest.request(base, "/api/connections").header("Cookie", cookie), 401);
                LocalAuthTest.expect(LocalAuthTest.valid(base, "/api/query").header("Origin", ""), 401);
                String session = get(base, "/api/auth/session", 200);
                LocalAuthTest.check(session.contains(workspace.actor().ownerKey()) && session.contains("\"provider\":\"local\""), "Manifest-derived actor");
                get(base, "/healthz", 200);
                get(base, "/api/health", 200);
                for (String path : List.of("/", "/index.html", "/login", "/auth/github", "/auth/github/callback", "/auth/logout", "/mcp", "/mcp.js", "/api/mcp/tokens/x", "/api/unknown")) get(base, path, 404);
                LocalAuthTest.check(get(base, "/api/local/mcp", 200).equals("{\"enabled\":false,\"endpoint\":null}"), "Default MCP is disabled with authenticated management");
                LocalAuthTest.check(get(base, "/api/mcp/tokens", 200).contains("\"endpoint\":null"), "Token listing available without MCP listener");
                LocalAuthTest.expect(LocalAuthTest.request(base, "/mcp").header("Authorization", "Bearer " + CAP), 401);
                post(base, "/api/connections", PROFILE, 200);
                LocalAuthTest.check(get(base, "/api/connections", 200).contains("saved"), "Saved profile");
                post(base, "/api/connections/connect", PROFILE, 200);
                LocalAuthTest.check(get(base, "/api/columns?namespace=app&table=fixture&connectionId=saved", 200).contains("postgresql_column"), "Synthetic columns");
                int before = executed.size();
                post(base, "/api/query-extra", "{\"sql\":\"DELETE FROM fixture\"}", 404);
                post(base, "/api/query", "{\"sql\":\"SELECT 1; DELETE FROM fixture\"}", 422);
                post(base, "/api/query", "{\"sql\":" + JsonUtil.quote("x".repeat(20_001)) + "}", 422);
                post(base, "/api/query", "{\"sql\":" + JsonUtil.quote("x".repeat(66_000)) + "}", 413);
                LocalAuthTest.expect(LocalAuthTest.valid(base, "/api/query").header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofInputStream(() -> new java.io.ByteArrayInputStream(new byte[65_537]))), 413);
                LocalAuthTest.check(executed.size() == before, "Path/body/SQL validation before JDBC");
                String boundaryBody = "{\"sql\":\"SELECT 1 LIMIT 1\"}";
                post(base, "/api/query", boundaryBody + " ".repeat(65_536 - boundaryBody.length()), 200);
                inspectPending[0] = true;
                String query = post(base, "/api/query", "{\"connectionId\":\"saved\",\"ownerId\":\"1001\",\"sql\":\"SELECT 1 LIMIT 1\"}", 200);
                inspectPending[0] = false;
                String requestId = JsonUtil.stringField(query, "requestId");
                post(base, "/api/activity/exports", "{\"queryRequestId\":" + JsonUtil.quote(requestId) + ",\"format\":\"csv\",\"rowCount\":1}", 200);
                get(base, "/api/activity?scope=all", 403);
                get(base, "/api/activity/users", 403);
                String activity = get(base, "/api/activity", 200);
                LocalAuthTest.check(activity.contains("result.export_requested") && activity.contains("\"source\":\"" + kind + "\""), "Trusted audit source");
                var events = new AuditStore(config.dataDir).list(workspace.actor().ownerKey(), false, Map.of()).events();
                LocalAuthTest.check(events.stream().allMatch(e -> workspace.actor().ownerKey().equals(e.userId)), "Headers and payload never select another actor");
                LocalAuthTest.check(events.stream().filter(e -> e.action.equals("query.execute") && e.httpStatus == 200).anyMatch(e -> e.outcome.equals("success") && e.source.equals(kind)), "Query outcome audit");
                before = executed.size(); fail[0] = true;
                post(base, "/api/query", "{\"connectionId\":\"saved\",\"sql\":\"UPDATE fixture SET x=2\"}", 502);
                LocalAuthTest.check(executed.size() == before + 1, "Uncertain write is never retried"); fail[0] = false;
                try (var db = DriverManager.getConnection("jdbc:sqlite:" + config.dataDir.resolve("audit.sqlite")); var sql = db.createStatement()) {
                    sql.execute("CREATE TRIGGER fail_local_intent BEFORE INSERT ON audit_events BEGIN SELECT RAISE(FAIL, 'fixture'); END");
                }
                before = executed.size();
                post(base, "/api/query", "{\"sql\":\"DELETE FROM fixture\"}", 503);
                LocalAuthTest.check(executed.size() == before, "Audit intent failure blocks JDBC");
            } finally { server.stop(); server.stop(); }
            LocalAuthTest.check(!Files.exists(config.dataDir.resolve("credentials.key")), "No local raw credential key");
        }
    }
    static void serverBoundary(Path root) throws Exception {
        AppConfig config = AppConfig.load(root, Map.of("GITHUB_CLIENT_ID", "fixture", "GITHUB_CLIENT_SECRET", "fixture"));
        var stores = new ConnectionWorkspaces(config);
        rejected(() -> new ThriftQueryServer(config, stores, new LocalAuth(new byte[32], LocalAuthTest.OWNER)));
        var server = new ThriftQueryServer(config, stores, new GitHubAuth(config.auth, (code, verifier) -> new GitHubAuth.User("1001", "fixture")));
        try {
            server.start(0); String base = "http://127.0.0.1:" + server.port();
            LocalAuthTest.expect(LocalAuthTest.valid(base, "/api/connections"), 401);
            LocalAuthTest.expect(LocalAuthTest.request(base, "/mcp").header("Authorization", "Bearer " + CAP), 401);
            String cookie = GitHubAuthTest.login(base);
            String session = LocalAuthTest.expect(LocalAuthTest.request(base, "/api/auth/session").header("Cookie", cookie), 200).body();
            LocalAuthTest.check(session.contains("\"provider\":\"github\"") && session.contains("\"id\":\"1001\""), "Server DTO remains numeric with github provider");
        } finally { server.stop(); }
    }
    static String get(String base, String path, int status) throws Exception { return LocalAuthTest.expect(LocalAuthTest.valid(base, path).header("X-GridBase-Account", "1001"), status).body(); }
    static String post(String base, String path, String body, int status) throws Exception {
        return LocalAuthTest.expect(LocalAuthTest.valid(base, path).header("X-GridBase-Account", "1001").header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)), status).body();
    }
    static void rejected(Runnable action) { try { action.run(); throw new AssertionError("Unsafe auth configuration accepted"); } catch (IllegalArgumentException expected) { } }
    static void rejectedStart(ThriftQueryServer server) throws Exception { try { server.start(0); throw new AssertionError("Non-loopback local bind accepted"); } catch (IllegalArgumentException expected) { } }
}
