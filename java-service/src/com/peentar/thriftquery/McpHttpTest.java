package com.peentar.thriftquery;

import com.google.gson.*;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.util.*;

/** Real HTTP/SQLite fixture; never connects to an external database. */
public final class McpHttpTest {
    static final HttpClient CLIENT = HttpClient.newHttpClient();
    static String base, cookie, secret;
    static JsonObject request(String method, JsonObject params) {
        JsonObject body = new JsonObject(); body.addProperty("jsonrpc", "2.0"); body.addProperty("id", "fixture-1"); body.addProperty("method", method);
        if (params != null) body.add("params", params); return body;
    }
    static HttpResponse<String> send(String path, String method, String body, String bearer, String session, String origin, String protocol) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create(base + path)).header("Accept", "application/json, text/event-stream");
        if (bearer != null) builder.header("Authorization", "Bearer " + bearer);
        if (session != null) builder.header("Cookie", session).header("X-GridBase-Account", "1001");
        if (origin != null) builder.header("Origin", origin);
        if (protocol != null) builder.header("MCP-Protocol-Version", protocol);
        if (body != null) builder.header("Content-Type", "application/json");
        return CLIENT.send(builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }
    static JsonObject rpc(String method, JsonObject params) throws Exception {
        var response = send("/mcp", "POST", request(method, params).toString(), secret, null, null, "2025-11-25");
        check(response.statusCode() == 200, response.body()); return StrictJson.object(response.body());
    }
    static JsonObject object(String json) { return StrictJson.object(json); }
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-mcp-http");
        AppConfig config = AppConfig.load(root, Map.of("GITHUB_CLIENT_ID", "dummy-id", "GITHUB_CLIENT_SECRET", "dummy-secret"));
        Files.createDirectories(config.publicDir);
        String settingsScript = Files.readString(Path.of("public/mcp.js"));
        Files.writeString(config.publicDir.resolve("mcp.js"), settingsScript);
        ConnectionWorkspaces workspaces = new ConnectionWorkspaces(config, profile -> new JdbcService(config, profile, () -> { throw new java.sql.SQLException("fixture-secret-must-not-leak"); }));
        GitHubAuth.User[] login = {new GitHubAuth.User("1001", "fixture-user")};
        ThriftQueryServer server = new ThriftQueryServer(config, workspaces, new GitHubAuth(config.auth, (code, verifier) -> login[0]));
        try {
            server.start(0); base = "http://127.0.0.1:" + server.port(); cookie = GitHubAuthTest.login(base);
            var asset = send("/mcp.js", "GET", null, null, cookie, null, null);
            check(asset.statusCode() == 200, "MCP settings script must not be intercepted by the /mcp transport prefix: " + asset.statusCode());
            check(asset.headers().firstValue("Content-Type").orElse("").startsWith("text/javascript") && asset.body().equals(settingsScript), "Authenticated settings asset returns real JavaScript");
            check(send("/mcp.js", "GET", null, null, null, null, null).statusCode() == 303, "Settings asset keeps browser session protection");
            check(send("/mcp.js-extra", "GET", null, null, cookie, null, null).statusCode() == 404, "Asset prefix does not expose other paths");
            check(send("/api/mcp/tokens", "GET", null, null, cookie, null, null).statusCode() == 200, "Management route exists");
            String profile = "{\"connectionId\":\"saved\",\"name\":\"Fixture read-only\",\"type\":\"postgresql\",\"jdbcUrl\":\"jdbc:postgresql://fixture/db\",\"username\":\"dummy\",\"password\":\"dummy-password\",\"mcpReadOnly\":true}";
            check(send("/api/connections", "POST", profile, null, cookie, null, null).statusCode() == 200, "Save fixture profile");
            var created = send("/api/mcp/tokens", "POST", "{\"name\":\"fixture token\",\"scope\":\"read_only\",\"expiresInDays\":30,\"connectionIds\":[\"saved\"]}", null, cookie, null, null);
            check(created.statusCode() == 201, created.body()); secret = object(created.body()).get("secret").getAsString();
            String tokenId = object(created.body()).getAsJsonObject("token").get("id").getAsString();
            check(created.headers().firstValue("Cache-Control").orElse("").contains("no-store"), "No-store token response");
            var listed = send("/api/mcp/tokens", "GET", null, null, cookie, null, null);
            check(!listed.body().contains(secret) && !listed.body().contains("dummy-password"), "Management list excludes secrets");
            check(send("/api/mcp/tokens", "GET", null, secret, null, null, null).statusCode() == 401, "Bearer cannot manage tokens");
            check(send("/api/mcp/tokens/11111111-1111-4111-8111-111111111111", "DELETE", null, null, cookie, null, null).statusCode() == 404, "Unknown or foreign tokens cannot be revoked as owned records");
            check(send("/mcp", "POST", request("ping", null).toString(), null, cookie, null, null).statusCode() == 401, "Cookie cannot authenticate MCP");
            check(send("/mcp", "POST", request("ping", null).toString(), secret, null, "https://evil.example", null).statusCode() == 403, "Foreign origin rejected");
            check(send("/mcp", "GET", null, secret, null, null, null).statusCode() == 405, "No SSE stream");
            check(send("/mcp?token=forbidden", "POST", request("ping", null).toString(), secret, null, null, null).statusCode() == 400, "No URL credentials");
            check(send("/mcp", "POST", request("ping", null).toString(), secret, null, null, "1900-01-01").statusCode() == 400, "Protocol version validated");
            var initialized = rpc("initialize", object("{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"fixture\",\"version\":\"1\"}}"));
            check(initialized.getAsJsonObject("result").get("protocolVersion").getAsString().equals("2025-11-25"), initialized.toString());
            check(send("/mcp", "POST", "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}", secret, null, null, null).statusCode() == 202, "Notification has no body");
            check(rpc("tools/list", null).getAsJsonObject("result").getAsJsonArray("tools").size() == 5, "Five real MCP tools");
            check(rpc("tools/call", object("{\"name\":\"list_connections\",\"arguments\":{}}")).toString().contains("Fixture read-only"), "Saved disconnected profiles available");
            var denied = rpc("tools/call", object("{\"name\":\"execute_query\",\"arguments\":{\"connectionId\":\"saved\",\"sql\":\"DELETE FROM fixture\"}}"));
            check(denied.getAsJsonObject("result").get("isError").getAsBoolean(), "Read-only write rejected");
            var failed = rpc("tools/call", object("{\"name\":\"execute_query\",\"arguments\":{\"connectionId\":\"saved\",\"sql\":\"SELECT 1\"}}"));
            check(failed.getAsJsonObject("result").get("isError").getAsBoolean() && !failed.toString().contains("fixture-secret-must-not-leak"), "JDBC error safe");
            var audit = new AuditStore(config.dataDir).list("1001", false, Map.of());
            check(audit.events().stream().anyMatch(e -> e.source.equals("mcp") && e.action.equals("query.execute") && e.outcome.equals("failure") && e.httpStatus == 200), "HTTP 200 SQL failures audited explicitly");
            check(!audit.toJson().contains(secret), "No bearer in audit");
            var duplicate = send("/mcp", "POST", "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"method\":\"tools/list\"}", secret, null, null, null);
            check(object(duplicate.body()).getAsJsonObject("error").get("code").getAsInt() == -32700, "Duplicate keys rejected");
            var batch = send("/mcp", "POST", "[]", secret, null, null, null);
            check(object(batch.body()).getAsJsonObject("error").get("code").getAsInt() == -32600, "JSON batch is invalid request, not malformed JSON");
            var integerId = send("/mcp", "POST", "{\"jsonrpc\":\"2.0\",\"id\":9007199254740993,\"method\":\"ping\"}", secret, null, null, null);
            check(integerId.body().contains("9007199254740993"), "Large integral request ID preserved");
            check(rpc("not_a_method", null).getAsJsonObject("error").get("code").getAsInt() == -32601, "Unknown method code");
            var ownCookie = cookie;
            login[0] = new GitHubAuth.User("2002", "other-user");
            String foreignCookie = GitHubAuthTest.login(base);
            var foreignList = CLIENT.send(HttpRequest.newBuilder(URI.create(base + "/api/mcp/tokens")).header("Cookie", foreignCookie).header("X-GridBase-Account", "2002").GET().build(), HttpResponse.BodyHandlers.ofString());
            check(foreignList.statusCode() == 200 && object(foreignList.body()).getAsJsonArray("tokens").isEmpty(), "Token listing isolates owners");
            var foreignRevoke = CLIENT.send(HttpRequest.newBuilder(URI.create(base + "/api/mcp/tokens/" + tokenId)).header("Cookie", foreignCookie).header("X-GridBase-Account", "2002").DELETE().build(), HttpResponse.BodyHandlers.ofString());
            check(foreignRevoke.statusCode() == 404 && !rpc("ping", null).has("error"), "Foreign revoke cannot affect owner token");
            cookie = ownCookie;
            String fullToken = object(send("/api/mcp/tokens", "POST", "{\"name\":\"full ceiling\",\"scope\":\"full_access\",\"expiresInDays\":30,\"connectionIds\":[\"saved\"]}", null, cookie, null, null).body()).get("secret").getAsString();
            String readToken = secret;
            secret = fullToken;
            check(rpc("tools/call", object("{\"name\":\"execute_query\",\"arguments\":{\"connectionId\":\"saved\",\"sql\":\"UPDATE fixture SET x=2\"}}")).toString().contains("kebijakan token"), "Full-access respects read-only profile ceiling");
            secret = readToken;
            check(send("/api/connections", "POST", profile.replace("dummy-password", "changed-dummy-password"), null, cookie, null, null).statusCode() == 200, "Edit profile");
            check(rpc("tools/call", object("{\"name\":\"list_connections\",\"arguments\":{}}")).toString().contains("\\\"connections\\\":[]"), "Changed profile generation invalidates grant");
            check(send("/api/connections/saved", "DELETE", null, null, cookie, null, null).statusCode() == 200, "Delete profile");
            check(send("/api/connections", "POST", profile, null, cookie, null, null).statusCode() == 200, "Recreate identical ID");
            check(rpc("tools/call", object("{\"name\":\"list_connections\",\"arguments\":{}}")).toString().contains("\\\"connections\\\":[]"), "Delete/recreate cannot revive old grant");
            check(send("/api/mcp/tokens/" + tokenId, "DELETE", null, null, cookie, null, null).statusCode() == 200, "Owner revokes");
            check(send("/mcp", "POST", request("ping", null).toString(), secret, null, null, null).statusCode() == 401, "Revocation immediately enforced");
            System.out.println("MCP HTTP tests passed (real SQLite + dummy JDBC)");
        } finally { server.stop(); try (var paths = Files.walk(root)) { for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); } }
    }
    static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
