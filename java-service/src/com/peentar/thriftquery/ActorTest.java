package com.peentar.thriftquery;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.sql.DriverManager;
import java.util.*;

/** Trusted actor boundaries with real temporary SQLite and HTTP; no external identity or JDBC calls. */
public final class ActorTest {
    private static final String UUID_A = "11111111-2222-4333-8444-555555555555";
    private static final Actor LOCAL = Actor.local(UUID_A, "Offline User");
    private static final Actor OTHER = Actor.local("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "Other User");
    private static final Actor GITHUB = Actor.github("1001", "alice");
    private static final HttpClient CLIENT = HttpClient.newHttpClient();
    private static final ConnectionSettings SETTINGS = ConnectionSettings.fromJson("{\"type\":\"postgresql\",\"name\":\"Private fixture\",\"host\":\"fixture\",\"database\":\"app\",\"username\":\"dummy\",\"password\":\"dummy-secret\",\"mcpReadOnly\":true}");

    public static void main(String[] args) throws Exception {
        validation();
        Path root = Files.createTempDirectory("gridbase-actor");
        try {
            connections(root.resolve("connections"));
            audits(root.resolve("audits"));
            tokens(root.resolve("tokens"));
            serverBoundaries(root.resolve("server"));
            localRequests(root.resolve("local"));
        } finally {
            try (var paths = Files.walk(root)) { for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); }
        }
        System.out.println("Actor validation, unchanged GitHub AAD, local ownership/audit/token and HTTP auth boundary tests passed");
    }

    private static void validation() {
        check(GITHUB.ownerKey().equals("1001") && GITHUB.provider().equals("github"), "GitHub numeric owner is unchanged");
        check(LOCAL.ownerKey().equals("local:11111111-2222-4333-8444-555555555555") && !LOCAL.ownerKey().equals(GITHUB.ownerKey()), "Local namespace is disjoint");
        check(new GitHubAuth.User("1001", "alice").toActor().equals(GITHUB), "GitHub DTO bridges without identity changes");
        check(Actor.fromOwnerKey("1001", "alice").equals(GITHUB), "Stored numeric owners remain GitHub");
        check(Actor.fromOwnerKey(LOCAL.ownerKey(), "Offline User").equals(LOCAL), "Stored local actor parses exactly");
        for (String id : List.of("0", "01", "-1", "1001 ", LOCAL.ownerKey(), UUID_A, "100000000000000000000")) invalid(() -> Actor.github(id, "alice"));
        for (String login : List.of("", "a_b", "a".repeat(40), "alice\n")) invalid(() -> Actor.github("1001", login));
        invalid(() -> Actor.github(null, "alice"));
        invalid(() -> Actor.github("1001", null));
        invalid(() -> new Actor("local", "1001", "Offline User"));
        invalid(() -> new Actor("github", LOCAL.ownerKey(), "alice"));
        invalid(() -> new Actor("other", "1001", "alice"));
        invalid(() -> new Actor(null, "1001", "alice"));
        for (String uuid : List.of("1001", LOCAL.ownerKey(), "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "1-2222-4333-8444-555555555555", UUID_A + " ", "{" + UUID_A + "}")) invalid(() -> Actor.local(uuid, "Offline User"));
        invalid(() -> Actor.local(null, "Offline User"));
        for (String owner : List.of(UUID_A, "local:1001", "LOCAL:" + UUID_A, "github:1001", "local:AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "local:" + UUID_A + "\n")) invalid(() -> Actor.fromOwnerKey(owner, "alice"));
        invalid(() -> Actor.fromOwnerKey(null, "alice"));
        for (String label : List.of("", " ", "x".repeat(81), "tab\tname", "line\nname", "control\u007f", "control\u0085")) invalid(() -> Actor.local(UUID_A, label));
        invalid(() -> Actor.local(UUID_A, null));
        check(Actor.local(UUID_A, "x".repeat(80)).login().length() == 80, "Bounded display label accepts maximum length");
    }

    private static void connections(Path root) throws Exception {
        Files.createDirectories(root);
        // Independently construct the pre-Actor schema-v2 format, not with ConnectionStore encryption.
        byte[] key = new byte[32], nonce = new byte[12];
        Arrays.fill(key, (byte) 7); Arrays.fill(nonce, (byte) 3);
        Files.write(root.resolve("credentials.key"), key);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        cipher.updateAAD("1001\0old-github".getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(SETTINGS.toJson().getBytes(StandardCharsets.UTF_8));
        byte[] old = ByteBuffer.allocate(12 + encrypted.length).put(nonce).put(encrypted).array();
        try (var db = DriverManager.getConnection("jdbc:sqlite:" + root.resolve("gridbase.sqlite")); var sql = db.createStatement()) {
            sql.executeUpdate("CREATE TABLE connections (id TEXT PRIMARY KEY NOT NULL, settings BLOB NOT NULL, owner_id TEXT)");
            sql.executeUpdate("PRAGMA user_version=2");
            try (var insert = db.prepareStatement("INSERT INTO connections VALUES('old-github',?,'1001')")) { insert.setBytes(1, old); insert.executeUpdate(); }
        }
        var github = new ConnectionStore(root, GITHUB);
        var local = new ConnectionStore(root, LOCAL);
        var other = new ConnectionStore(root, OTHER);
        check(github.load().get("old-github").toJson().contains("dummy-secret"), "Existing numeric AAD decrypts without migration");
        check(local.load().isEmpty() && other.load().isEmpty(), "Local owners cannot read existing GitHub profiles");
        local.save("local-profile", SETTINGS);
        check(other.load().isEmpty() && github.load().size() == 1, "Local profiles never leak across namespaces or owners");
        check(!other.canWrite("local-profile") && !local.canWrite("old-github"), "Foreign IDs cannot be overwritten");
        try { other.save("local-profile", SETTINGS); throw new AssertionError("Foreign overwrite accepted"); } catch (ConnectionRegistry.UnknownConnectionException expected) { }
        try { local.save("old-github", SETTINGS); throw new AssertionError("GitHub overwrite accepted"); } catch (ConnectionRegistry.UnknownConnectionException expected) { }
        other.delete("local-profile"); local.delete("old-github");
        check(new ConnectionStore(root, LOCAL).load().size() == 1 && github.load().size() == 1, "Foreign deletes do nothing; local reopen works");
        invalid(() -> ConnectionStore.migrateLegacy(root, LOCAL.ownerKey()));
        try (var db = DriverManager.getConnection("jdbc:sqlite:" + root.resolve("gridbase.sqlite")); var sql = db.createStatement()) {
            try (var rows = sql.executeQuery("SELECT owner_id,settings FROM connections WHERE id='old-github'")) { check(rows.next() && rows.getString(1).equals("1001") && Arrays.equals(rows.getBytes(2), old), "No owner rewrite or ciphertext migration"); }
            try (var rows = sql.executeQuery("PRAGMA user_version")) { check(rows.next() && rows.getInt(1) == 2, "Connection schema unchanged"); }
            try (var update = db.prepareStatement("UPDATE connections SET owner_id=? WHERE id='local-profile'")) { update.setString(1, OTHER.ownerKey()); update.executeUpdate(); }
        }
        try { other.load(); throw new AssertionError("Moved local ciphertext authenticated"); } catch (ConnectionStore.StoreException expected) { }
    }

    private static void audits(Path root) throws Exception {
        var store = new AuditStore(root);
        var github = query(store, GITHUB, "server");
        var local = query(store, LOCAL, "desktop");
        var other = query(store, OTHER, "vscode");
        check(store.list(LOCAL.ownerKey(), false, Map.of()).events().size() == 1, "Local audit own scope hides other local and GitHub events");
        check(store.ownedQuery(local.requestId, OTHER.ownerKey()) == null && store.ownedQuery(github.requestId, LOCAL.ownerKey()) == null, "Export correlation cannot cross owners or providers");
        check(store.ownedQuery(other.requestId, OTHER.ownerKey()) != null, "Local queries correlate for their owner");
        check(new AuditStore(root).list("1001", false, Map.of()).events().get(0).source.equals("server"), "Old numeric audit event remains readable");
        check(store.list("9009", true, Map.of("scope", "all", "userId", LOCAL.ownerKey())).events().size() == 1, "GitHub admin can filter local namespace");
        try { store.list(LOCAL.ownerKey(), true, Map.of("scope", "all")); throw new AssertionError("Local admin accepted"); } catch (AuditStore.Forbidden expected) { }
        for (String source : List.of("desktop", "vscode")) {
            invalid(() -> store.begin(new AuditStore.Event(GITHUB, "query.execute", source)));
            invalid(() -> store.begin(new AuditStore.Event((Actor) null, "query.execute", source)));
            store.begin(new AuditStore.Event(LOCAL, "result.export_requested", source));
            invalid(() -> store.begin(new AuditStore.Event(LOCAL, "mcp.connections", source)));
        }
        invalid(() -> store.begin(new AuditStore.Event(LOCAL, "query.execute", "forged")));
        invalid(() -> store.begin(new AuditStore.Event(LOCAL, "query.execute", "server")));
        invalid(() -> store.begin(new AuditStore.Event(LOCAL, "result.export_requested", "browser")));
        invalid(() -> store.begin(new AuditStore.Event(GITHUB, "query.execute", "browser")));
        invalid(() -> store.begin(new AuditStore.Event(GITHUB, "result.export_requested", "server")));
        var operation = new McpAudit(store).start(LOCAL, UUID_A, "offline token", "mcp.connections", null, null);
        check(!operation.complete(true, false, null), "MCP audit accepts a trusted local actor");
        check(store.list(LOCAL.ownerKey(), false, Map.of()).events().stream().anyMatch(e -> e.source.equals("mcp") && e.tokenId.equals(UUID_A)), "MCP token identity is safe UUID/name, not bearer");
    }

    private static void tokens(Path root) {
        var store = new McpTokenStore(root);
        var grants = List.of(new McpTokenStore.Grant("profile", UUID_A, true));
        var local = store.create(LOCAL, "Local token", "read_only", 30, grants);
        var github = store.create(GITHUB, "GitHub token", "read_only", 30, grants);
        store.create(OTHER, "Other token", "read_only", 30, grants);
        check(Actor.fromOwnerKey(store.authenticate(local.secret()).ownerId(), store.authenticate(local.secret()).login()).equals(LOCAL), "Stored token metadata resolves its actor");
        check(new McpTokenStore(root).list(LOCAL.ownerKey()).equals(List.of(local.token())), "Local token ownership survives reopen");
        store.revoke(OTHER.ownerKey(), local.token().id()); store.revoke(LOCAL.ownerKey(), github.token().id());
        check(store.authenticate(local.secret()) != null && store.authenticate(github.secret()) != null, "Cross-owner revocation cannot affect local or GitHub tokens");
        store.revoke(LOCAL.ownerKey(), local.token().id());
        check(store.authenticate(local.secret()) == null, "Own local token can be revoked");
    }

    private static void serverBoundaries(Path root) throws Exception {
        AppConfig config = AppConfig.load(root, Map.of("GITHUB_CLIENT_ID", "dummy-id", "GITHUB_CLIENT_SECRET", "dummy-secret", "AUDIT_ADMIN_IDS", "1001"));
        for (String setting : List.of("AUDIT_ADMIN_IDS", "LEGACY_CONNECTION_OWNER_ID")) invalid(() -> AppConfig.load(root, Map.of(setting, LOCAL.ownerKey())));
        var workspaces = new ConnectionWorkspaces(config);
        var localRegistry = workspaces.forOwner(LOCAL);
        localRegistry.save("local-only", SETTINGS);
        check(workspaces.forOwner(OTHER).entries().isEmpty() && workspaces.forOwner(GITHUB).entries().isEmpty(), "Runtime workspaces are actor-scoped");
        var profile = localRegistry.mcp("local-only");
        var token = new McpTokenStore(config.dataDir).create(LOCAL, "Offline MCP", "read_only", 30, List.of(new McpTokenStore.Grant(profile.id(), profile.generation(), true)));
        GitHubAuth github = new GitHubAuth(config.auth, (code, verifier) -> new GitHubAuth.User("1001", "alice"));
        RequestAuth adapter = github;
        ThriftQueryServer server = new ThriftQueryServer(config, workspaces, adapter);
        try {
            server.start(0); String base = "http://127.0.0.1:" + server.port();
            check(get(base, "/api/connections", null, LOCAL.ownerKey()).statusCode() == 401, "Local header never authenticates server requests");
            String cookie = GitHubAuthTest.login(base);
            check(get(base, "/api/connections", cookie, LOCAL.ownerKey()).statusCode() == 409, "Numeric server session cannot select local owner header");
            var own = get(base, "/api/connections", cookie, "1001");
            check(own.statusCode() == 200 && !own.body().contains("local-only"), "GitHub session remains in its own workspace");
            String body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"list_connections\",\"arguments\":{}}}";
            var rpc = HttpRequest.newBuilder(URI.create(base + "/mcp")).header("Authorization", "Bearer " + token.secret()).header("Cookie", cookie).header("X-GridBase-Account", "1001").header("Accept", "application/json, text/event-stream").header("Content-Type", "application/json");
            var result = CLIENT.send(rpc.POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
            check(result.statusCode() == 200 && result.body().contains("local-only") && !result.body().contains("\"isError\":true"), "MCP resolves stored local actor, ignoring numeric cookie/account header");
            var events = new AuditStore(config.dataDir).list(LOCAL.ownerKey(), false, Map.of());
            check(events.events().size() == 1 && events.events().get(0).source.equals("mcp") && events.events().get(0).tokenId.equals(token.token().id()) && !events.toJson().contains(token.secret()), "MCP attribution uses stored owner and nonsecret token identity");
        } finally { server.stop(); }
    }

    private static void localRequests(Path root) throws Exception {
        AppConfig config = AppConfig.load(root, Map.of("AUDIT_ADMIN_IDS", "1001"));
        var audit = new ActivityAudit(config);
        check(!audit.admin(LOCAL) && audit.admin(GITHUB), "Server admin capability stays GitHub-only");
        invalid(() -> audit.wrap(null, GITHUB, "desktop"));
        invalid(() -> audit.wrap(null, (Actor) null, "vscode"));
        invalid(() -> audit.wrap(null, LOCAL, "server"));
        var query = query(audit.store, LOCAL, "desktop");
        var other = query(audit.store, OTHER, "vscode");
        // Test-only trusted embedding boundary: no production local authentication implementation.
        RequestAuth trusted = new RequestAuth() {
            public Actor actor(HttpExchange exchange) { return LOCAL; }
            public boolean handle(HttpExchange exchange, Set<String> admins) { return false; }
        };
        var server = new ThriftQueryServer(config, new ConnectionWorkspaces(config), trusted);
        try {
            server.start(0); String base = "http://127.0.0.1:" + server.port();
            check(get(base, "/api/connections", null, null).statusCode() == 200, "Server internals consume trusted Actor via RequestAuth");
            check(export(base, query.requestId).statusCode() == 200, "Local owner can correlate its own export");
            check(export(base, other.requestId).statusCode() == 404, "Local owner cannot export another actor query");
            var nativeEvents = audit.store.list(LOCAL.ownerKey(), false, Map.of()).events().stream().filter(e -> e.action.equals("connection.list") || e.action.equals("result.export_requested")).toList();
            check(nativeEvents.size() == 3 && nativeEvents.stream().allMatch(e -> e.source.equals("desktop") && e.finishedAt != null && e.durationMs != null), "All local requests and exports persist completed desktop audit records");
            check(nativeEvents.stream().anyMatch(e -> e.action.equals("connection.list") && Integer.valueOf(200).equals(e.httpStatus) && e.outcome.equals("success")), "Connection list completion is audited");
            check(nativeEvents.stream().anyMatch(e -> e.action.equals("result.export_requested") && query.requestId.equals(e.queryRequestId) && Integer.valueOf(200).equals(e.httpStatus) && e.outcome.equals("success")), "Successful own export completion is audited");
            check(nativeEvents.stream().anyMatch(e -> e.action.equals("result.export_requested") && Integer.valueOf(404).equals(e.httpStatus) && e.outcome.equals("failure")), "Rejected foreign export completion is audited");
        } finally { server.stop(); }
        HttpServer vscode = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        vscode.createContext("/api/activity/exports", raw -> {
            var exchange = audit.wrap(raw, LOCAL, "vscode");
            try { exchange.beginOperation(); new ActivityApi(audit).handle(exchange, LOCAL); }
            finally { exchange.close(); }
        });
        try {
            vscode.start();
            check(export("http://127.0.0.1:" + vscode.getAddress().getPort(), query.requestId).statusCode() == 200, "Trusted VS Code source accepted for local export");
            check(audit.store.list(LOCAL.ownerKey(), false, Map.of("action", "result.export_requested")).events().stream().anyMatch(e -> e.source.equals("vscode")), "VS Code source survives persistence");
        } finally { vscode.stop(0); }
    }

    private static AuditStore.Event query(AuditStore store, Actor actor, String source) {
        var event = new AuditStore.Event(actor, "query.execute", source); store.begin(event);
        event.outcome = "success"; event.finishedAt = System.currentTimeMillis(); event.durationMs = 1L; event.httpStatus = 200; event.code = "OK"; event.returnedRows = 1L; store.finish(event); return event;
    }
    private static HttpResponse<String> get(String base, String path, String cookie, String owner) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create(base + path));
        if (cookie != null) builder.header("Cookie", cookie);
        if (owner != null) builder.header("X-GridBase-Account", owner);
        return CLIENT.send(builder.GET().build(), HttpResponse.BodyHandlers.ofString());
    }
    private static HttpResponse<String> export(String base, String requestId) throws Exception {
        return CLIENT.send(HttpRequest.newBuilder(URI.create(base + "/api/activity/exports")).header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString("{\"queryRequestId\":\"" + requestId + "\",\"format\":\"csv\",\"rowCount\":1}")).build(), HttpResponse.BodyHandlers.ofString());
    }
    private static void invalid(Runnable action) { try { action.run(); throw new AssertionError("Invalid actor or boundary accepted"); } catch (IllegalArgumentException expected) { } }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
