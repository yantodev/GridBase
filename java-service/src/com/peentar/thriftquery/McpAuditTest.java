package com.peentar.thriftquery;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/** Real SQLite/HTTP audit contracts; no remote databases or bearer credentials. */
public final class McpAuditTest {
    private static final GitHubAuth.User ALICE = new GitHubAuth.User("1001", "alice");
    private static final String TOKEN_ID = "11111111-2222-4333-8444-555555555555";
    private static final String TOKEN_NAME = "CLI \"work\"";
    private static final String SECRET = "gb_mcp_fixture_never_persist_this_secret";

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-mcp-audit-");
        try {
            pendingIntentAndSuccess(root.resolve("lifecycle"));
            explicitToolFailures(root.resolve("outcomes"));
            beginFailureBlocksOperation(root.resolve("begin-failure"));
            completionFailurePreservesResult(root.resolve("finish-failure"));
            allowedActionsAndSources(root.resolve("validation"));
            migrate(root.resolve("v2"), 2);
            migrate(root.resolve("v1"), 1);
            rejectFutureSchema(root.resolve("future"));
            tokenManagementRouting(root.resolve("http"));
            System.out.println("MCP audit lifecycle, migration, token identity and HTTP tests passed");
        } finally {
            try (var files = Files.walk(root)) {
                for (var file : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(file);
            }
        }
    }

    private static void pendingIntentAndSuccess(Path root) throws Exception {
        var store = new AuditStore(root);
        var operation = new McpAudit(store).start(ALICE, TOKEN_ID, TOKEN_NAME, "query.execute", "warehouse", "SELECT 1");
        var pending = event(store, operation.requestId());
        check(pending.outcome.equals("pending") && pending.httpStatus == null && pending.finishedAt == null,
                "Start must persist pending intent before handing control to JDBC");
        check("SELECT 1".equals(pending.sqlText)
                        && "e004ebd5b5532a4b85984a62f8ad48a81aa3460c1ca07701f386135d72cdecf5".equals(pending.sqlHash)
                        && "SELECT".equals(pending.sqlOperation),
                "SQL text, operation and SHA-256 must already be durable before execution");
        check(TOKEN_ID.equals(pending.tokenId) && TOKEN_NAME.equals(pending.tokenName)
                        && "mcp".equals(pending.source) && "warehouse".equals(pending.connectionId),
                "Pending intent identifies token and target, not a bearer credential");
        check(store.list("2002", false, Map.of()).events().isEmpty(), "MCP SQL remains owner-isolated");
        check(store.list("9009", true, Map.of("scope", "all")).events().size() == 1, "Audit admins retain MCP visibility");
        var result = new JdbcService.QueryResult(List.of("id"), List.of(List.of("1")), false, 2L, null);
        check(!operation.complete(true, false, result), "Successful completion reports a complete audit");
        var completed = event(new AuditStore(root), operation.requestId());
        check(completed.outcome.equals("success") && completed.code.equals("OK") && completed.httpStatus == 200
                        && completed.returnedRows == 1L && completed.affectedRows == null && completed.durationMs >= 0,
                "Successful tool result records actual row counts and elapsed duration");
        check(store.ownedQuery(operation.requestId(), ALICE.id()) != null, "Successful MCP query supports owner correlation");
        String json = completed.toJson();
        check(json.contains("\"tokenId\":\"" + TOKEN_ID + "\"")
                        && json.contains("\"tokenName\":\"CLI \\\"work\\\"\"")
                        && !json.contains(SECRET) && !json.contains("Authorization"),
                "Activity JSON exposes escaped nonsecret token identity only");
        check(!operation.complete(false, true, null) && event(store, operation.requestId()).outcome.equals("success"),
                "Repeated completion cannot overwrite the first actual outcome");
        assertNoSecret(root);
    }

    private static void explicitToolFailures(Path root) {
        var store = new AuditStore(root);
        var audit = new McpAudit(store);
        var failure = audit.start(ALICE, TOKEN_ID, TOKEN_NAME, "query.execute", "warehouse", "SELECT broken");
        check(!failure.complete(false, false, null), "Tool failure still persists its completion");
        var failed = event(store, failure.requestId());
        check(failed.httpStatus == 200 && failed.outcome.equals("failure") && failed.code.equals("HTTP_502"),
                "HTTP 200 must not turn a tool execution failure into success");
        check(store.ownedQuery(failure.requestId(), ALICE.id()) == null, "Failed MCP queries cannot be exported as successful");
        var denial = audit.start(ALICE, TOKEN_ID, TOKEN_NAME, "query.execute", "warehouse", "DELETE FROM fixture");
        check(!denial.complete(false, true, null), "Denied call persists without executing SQL");
        var denied = event(store, denial.requestId());
        check(denied.httpStatus == 200 && denied.outcome.equals("denied") && denied.code.equals("HTTP_403"),
                "HTTP 200 must not turn a denied tool call into success");
        var write = audit.start(ALICE, TOKEN_ID, TOKEN_NAME, "query.execute", "warehouse", "UPDATE fixture SET id=2");
        check(!write.complete(true, false, JdbcService.QueryResult.empty(0, 3))
                        && event(store, write.requestId()).affectedRows == 3L,
                "MCP write results persist actual affected row counts");
    }

    private static void beginFailureBlocksOperation(Path root) throws Exception {
        var store = new AuditStore(root);
        execute(root, "CREATE TRIGGER fail_begin BEFORE INSERT ON audit_events BEGIN SELECT RAISE(FAIL, 'fixture'); END");
        boolean reachedJdbc = false;
        try {
            new McpAudit(store).start(ALICE, TOKEN_ID, TOKEN_NAME, "query.execute", "warehouse", "SELECT 1");
            reachedJdbc = true;
            throw new AssertionError("Failed durable intent allowed execution");
        } catch (AuditStore.Unavailable expected) { }
        check(!reachedJdbc && store.list(ALICE.id(), false, Map.of()).events().isEmpty(),
                "Audit begin failure must block the operation rather than returning an untracked handle");
    }

    private static void completionFailurePreservesResult(Path root) throws Exception {
        var store = new AuditStore(root);
        var operation = new McpAudit(store).start(ALICE, TOKEN_ID, TOKEN_NAME, "query.execute", "warehouse", "SELECT 1");
        execute(root, "CREATE TRIGGER fail_finish BEFORE UPDATE ON audit_events WHEN NEW.outcome <> 'pending' BEGIN SELECT RAISE(FAIL, 'fixture'); END");
        var result = new JdbcService.QueryResult(List.of("id"), List.of(List.of("1")), false, 0L, null);
        String actualResult = result.toJson();
        check(operation.complete(true, false, result), "Final persistence failure returns auditIncomplete, not a SQL error");
        check(actualResult.equals(result.toJson()) && result.rows().get(0).get(0).equals("1"), "Actual successful data is preserved");
        var pending = event(store, operation.requestId());
        check(pending.outcome.equals("pending") && "SELECT 1".equals(pending.sqlText)
                        && TOKEN_ID.equals(pending.tokenId), "Failed completion retains the durable SQL and token intent");
        execute(root, "DROP TRIGGER fail_finish");
        check(operation.complete(false, true, null) && event(store, operation.requestId()).outcome.equals("pending"),
                "Audit-incomplete status is stable without silently retrying or reclassifying the operation");
    }

    private static void allowedActionsAndSources(Path root) {
        var store = new AuditStore(root);
        var audit = new McpAudit(store);
        for (String action : List.of("mcp.connections", "metadata.databases", "metadata.namespaces", "metadata.tables", "metadata.columns")) {
            var operation = audit.start(ALICE, TOKEN_ID, TOKEN_NAME, action, action.equals("mcp.connections") ? null : "warehouse", null);
            check(!operation.complete(true, false, null) && event(store, operation.requestId()).source.equals("mcp"),
                    "MCP list and metadata actions support the explicit lifecycle: " + action);
        }
        for (String action : List.of("auth.login", "connection.save", "connection.list", "token.create", "token.revoke", "result.export_requested")) {
            invalid(() -> audit.start(ALICE, TOKEN_ID, TOKEN_NAME, action, null, null), "MCP source cannot forge unrelated action " + action);
            invalid(() -> store.begin(new AuditStore.Event(ALICE, action, "mcp")), "Store enforces MCP source/action pairing " + action);
        }
        invalid(() -> store.begin(new AuditStore.Event(ALICE, "mcp.connections", "server")), "MCP-only action cannot use ordinary source");
        invalid(() -> store.begin(new AuditStore.Event(ALICE, "query.execute", "browser")), "Browser cannot forge server queries");
        invalid(() -> store.begin(new AuditStore.Event(ALICE, "result.export_requested", "server")), "Exports remain browser-only");
        invalid(() -> audit.start(null, TOKEN_ID, TOKEN_NAME, "mcp.connections", null, null), "MCP requires a verified actor");
        invalid(() -> audit.start(ALICE, null, TOKEN_NAME, "mcp.connections", null, null), "MCP requires token identity");
        invalid(() -> audit.start(ALICE, TOKEN_ID, null, "mcp.connections", null, null), "MCP requires token name snapshot");
        invalid(() -> audit.start(ALICE, SECRET + "!", TOKEN_NAME, "mcp.connections", null, null), "Malformed token IDs fail validation");
        invalid(() -> audit.start(ALICE, "gb_mcp_" + "A".repeat(43), TOKEN_NAME, "mcp.connections", null, null),
                "Raw bearer credentials must be rejected when mistakenly passed as token identity");
        invalid(() -> audit.start(ALICE, TOKEN_ID, "\nsecret", "mcp.connections", null, null), "Token names cannot inject control characters");
        invalid(() -> audit.start(ALICE, TOKEN_ID, " ", "mcp.connections", null, null), "Blank token identity is not valid");
        invalid(() -> audit.start(ALICE, TOKEN_ID, "x".repeat(101), "mcp.connections", null, null), "Token name snapshots are bounded");
        var ordinary = new AuditStore.Event(ALICE, "metadata.tables", "server");
        ordinary.tokenId = TOKEN_ID; ordinary.tokenName = TOKEN_NAME;
        invalid(() -> store.begin(ordinary), "Ordinary server events cannot claim an MCP bearer identity");
        store.begin(new AuditStore.Event(ALICE, "query.execute", "server"));
        store.begin(new AuditStore.Event(ALICE, "result.export_requested", "browser"));
    }

    private static void migrate(Path root, int version) throws Exception {
        Files.createDirectories(root);
        try (var db = DriverManager.getConnection("jdbc:sqlite:" + root.resolve("audit.sqlite")); var sql = db.createStatement()) {
            sql.executeUpdate("CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL, user_id TEXT, login TEXT, action TEXT NOT NULL, source TEXT NOT NULL, connection_id TEXT, sql_operation TEXT, sql_hash TEXT, query_request_id TEXT, export_format TEXT, returned_rows INTEGER, affected_rows INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, duration_ms INTEGER, http_status INTEGER, outcome TEXT NOT NULL, code TEXT" + (version == 2 ? ", sql_text TEXT" : "") + ")");
            sql.executeUpdate("INSERT INTO audit_events(id,request_id,user_id,login,action,source,connection_id,returned_rows,started_at,finished_at,duration_ms,http_status,outcome,code" + (version == 2 ? ",sql_text" : "") + ") VALUES(7,'11111111-1111-4111-8111-111111111111','1001','alice','query.execute','server','legacy',3,1000,1001,1,200,'success','OK'" + (version == 2 ? ",'SELECT legacy'" : "") + ")");
            sql.executeUpdate("INSERT INTO audit_events(id,request_id,user_id,login,action,source,started_at,outcome) VALUES(19,'22222222-2222-4222-8222-222222222222','2002','bob','metadata.tables','server',1002,'pending')");
            sql.executeUpdate("PRAGMA user_version=" + version);
        }
        var store = new AuditStore(root);
        var events = store.list("9009", true, Map.of("scope", "all")).events();
        check(events.size() == 2 && events.get(0).id == 19 && events.get(1).id == 7,
                "Schema " + version + " migration must preserve all rows and stable cursor IDs");
        var old = events.get(1);
        check(old.outcome.equals("success") && old.returnedRows == 3L && old.startedAt == 1000
                        && old.finishedAt == 1001L && old.httpStatus == 200 && "legacy".equals(old.connectionId)
                        && (version == 2 ? "SELECT legacy".equals(old.sqlText) : old.sqlText == null)
                        && old.tokenId == null && old.tokenName == null,
                "Migration retains actual historical metadata and never invents token identity");
        check(events.get(0).outcome.equals("pending"), "Migration preserves pending rows");
        check(new AuditStore(root).list("9009", true, Map.of("scope", "all")).events().size() == 2,
                "Repeated migration/reopen does not duplicate rows");
        try (var db = DriverManager.getConnection("jdbc:sqlite:" + root.resolve("audit.sqlite")); var sql = db.createStatement(); var rows = sql.executeQuery("PRAGMA user_version")) {
            check(rows.next() && rows.getInt(1) == 3, "Migrated database advertises token-aware schema 3");
        }
        var operation = new McpAudit(store).start(ALICE, TOKEN_ID, TOKEN_NAME, "mcp.connections", null, null);
        operation.complete(true, false, null);
        check(event(store, operation.requestId()).id > 19, "Migrated inserts preserve the AUTOINCREMENT sequence");
    }

    private static void rejectFutureSchema(Path root) throws Exception {
        new AuditStore(root);
        execute(root, "PRAGMA user_version=4");
        try { new AuditStore(root); throw new AssertionError("Future audit schema accepted"); }
        catch (AuditStore.Unavailable expected) { }
    }

    private static void tokenManagementRouting(Path root) throws Exception {
        Files.createDirectories(root);
        var config = AppConfig.load(root, Map.of());
        var audit = new ActivityAudit(config);
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", raw -> {
            var exchange = audit.wrap(raw, ALICE);
            try {
                exchange.beginOperation();
                // A token response/body/header contains secrets that audit must never consume.
                exchange.getRequestBody().readAllBytes();
                byte[] response = ("{\"secret\":\"" + SECRET + "\"}").getBytes(StandardCharsets.UTF_8);
                int status = exchange.getRequestMethod().equals("POST") ? 201 : 200;
                exchange.sendResponseHeaders(status, response.length);
                exchange.getResponseBody().write(response);
            } finally { exchange.close(); }
        });
        server.start();
        try {
            var client = HttpClient.newHttpClient();
            String base = "http://127.0.0.1:" + server.getAddress().getPort();
            for (String route : List.of("POST /api/mcp/tokens", "DELETE /api/mcp/tokens/" + TOKEN_ID,
                    "DELETE /api/mcp/tokens", "GET /api/mcp/tokens", "POST /api/mcp/tokens-extra")) {
                String[] parts = route.split(" ", 2);
                var request = HttpRequest.newBuilder(URI.create(base + parts[1]))
                        .header("Authorization", "Bearer " + SECRET).header("Content-Type", "application/json")
                        .method(parts[0], HttpRequest.BodyPublishers.ofString("{\"token\":\"" + SECRET + "\"}")).build();
                var response = client.send(request, HttpResponse.BodyHandlers.ofString());
                check(response.statusCode() == (parts[0].equals("POST") ? 201 : 200), "Fixture management response is returned");
            }
            var events = audit.store.list(ALICE.id(), false, Map.of()).events();
            check(events.size() == 3 && events.stream().filter(e -> e.action.equals("token.create")).count() == 1
                            && events.stream().filter(e -> e.action.equals("token.revoke")).count() == 2,
                    "Only token POST and DELETE management routes create audit records");
            check(events.stream().allMatch(e -> e.source.equals("server") && e.outcome.equals("success")
                            && e.tokenId == null && e.tokenName == null && e.sqlText == null),
                    "Browser token management preserves HTTP completion semantics without inspecting secret payloads");
            check(!audit.store.list(ALICE.id(), false, Map.of()).toJson().contains(SECRET), "Management audit JSON excludes raw tokens");
            assertNoSecret(config.dataDir);
        } finally { server.stop(0); }
    }

    private static AuditStore.Event event(AuditStore store, String requestId) {
        return store.list(ALICE.id(), false, Map.of("limit", "100")).events().stream()
                .filter(event -> event.requestId.equals(requestId)).findFirst().orElseThrow();
    }
    private static void execute(Path root, String statement) throws Exception {
        try (var db = DriverManager.getConnection("jdbc:sqlite:" + root.resolve("audit.sqlite")); var sql = db.createStatement()) {
            sql.execute(statement);
        }
    }
    private static void assertNoSecret(Path root) throws Exception {
        try (var files = Files.list(root)) {
            for (var file : files.filter(f -> f.getFileName().toString().startsWith("audit.sqlite")).toList()) {
                check(!new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1).contains(SECRET),
                        "Raw bearer secret must not occur in SQLite, WAL or journal bytes");
            }
        }
    }
    private static void invalid(Runnable operation, String message) {
        try { operation.run(); throw new AssertionError(message); } catch (IllegalArgumentException expected) { }
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
