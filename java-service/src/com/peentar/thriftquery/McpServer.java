package com.peentar.thriftquery;

import com.google.gson.*;
import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Stateless Streamable HTTP JSON transport, with bearer-only authorization. */
final class McpServer implements AutoCloseable {
    private static final Set<String> VERSIONS = Set.of("2025-03-26", "2025-06-18", "2025-11-25");
    private static final Set<String> TOOLS = Set.of("list_connections", "list_databases", "list_tables", "describe_table", "execute_query");
    private static final int MAX_RESPONSE = 1024 * 1024;
    private final AppConfig config;
    private final ConnectionWorkspaces workspaces;
    private final McpTokenStore tokens;
    private final McpAudit audit;
    // Synchronous handoff: a cancelled but uncooperative driver retains its worker slot.
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(4, 4, 0L, TimeUnit.MILLISECONDS,
            new SynchronousQueue<>(), runnable -> { Thread thread = new Thread(runnable, "gridbase-mcp"); thread.setDaemon(true); return thread; }, new ThreadPoolExecutor.AbortPolicy());

    McpServer(AppConfig config, ConnectionWorkspaces workspaces, McpTokenStore tokens, AuditStore audit) {
        this.config = config; this.workspaces = workspaces; this.tokens = tokens; this.audit = new McpAudit(audit);
    }
    @Override public void close() { workers.shutdownNow(); }

    void handle(HttpExchange exchange) throws IOException {
        try {
            if (!exchange.getRequestURI().getPath().equals("/mcp")) { http(exchange, 404, "Endpoint tidak ditemukan."); return; }
            if (!config.auth.secure() && !exchange.getRemoteAddress().getAddress().isLoopbackAddress()) { http(exchange, 403, "MCP jarak jauh membutuhkan APP_URL HTTPS dan reverse proxy TLS tepercaya."); return; }
            String origin = exchange.getRequestHeaders().getFirst("Origin");
            if (origin != null && !origin.equals(config.auth.appUrl())) { http(exchange, 403, "Asal request tidak diizinkan."); return; }
            if (exchange.getRequestURI().getRawQuery() != null) { http(exchange, 400, "Query string tidak diizinkan."); return; }
            String bearer = bearer(exchange);
            McpTokenStore.Token token = tokens.authenticate(bearer);
            if (token == null) { exchange.getResponseHeaders().set("WWW-Authenticate", "Bearer realm=\"GridBase MCP\""); http(exchange, 401, "Token tidak valid, kedaluwarsa, atau telah dicabut."); return; }
            if (!exchange.getRequestMethod().equals("POST")) { exchange.getResponseHeaders().set("Allow", "POST"); http(exchange, 405, "Streaming/session endpoint tidak tersedia."); return; }
            String type = exchange.getRequestHeaders().getFirst("Content-Type");
            if (type == null || !type.split(";", 2)[0].trim().equalsIgnoreCase("application/json")) { http(exchange, 415, "Content-Type application/json wajib digunakan."); return; }
            String accept = exchange.getRequestHeaders().getFirst("Accept");
            if (!accepts(accept, "application/json") || !accepts(accept, "text/event-stream")) { http(exchange, 406, "Accept application/json dan text/event-stream wajib digunakan."); return; }
            String version = exchange.getRequestHeaders().getFirst("MCP-Protocol-Version");
            if (version != null && !VERSIONS.contains(version)) { http(exchange, 400, "Versi protokol MCP tidak didukung."); return; }
            String body;
            try { body = ThriftQueryServer.readBody(exchange); }
            catch (IOException | NumberFormatException large) { http(exchange, 413, "Body request melebihi 64 KiB atau tidak valid."); return; }
            JsonObject message;
            try {
                JsonElement parsed = StrictJson.parse(body);
                if (!parsed.isJsonObject()) { rpcError(exchange, JsonNull.INSTANCE, -32600, "Invalid Request"); return; }
                message = parsed.getAsJsonObject();
            }
            catch (IllegalArgumentException invalid) { rpcError(exchange, JsonNull.INSTANCE, -32700, "Parse error"); return; }
            JsonElement id = message.get("id");
            if (!validMessage(message, id)) { rpcError(exchange, JsonNull.INSTANCE, -32600, "Invalid Request"); return; }
            if (!message.has("id")) { noContent(exchange); return; }
            JsonObject params = message.has("params") ? message.getAsJsonObject("params") : new JsonObject();
            String method = message.get("method").getAsString();
            try {
                JsonObject result = switch (method) {
                    case "initialize" -> initialize(params);
                    case "ping" -> new JsonObject();
                    case "tools/list" -> tools(token, params);
                    case "tools/call" -> call(token, bearer, params);
                    default -> throw new RpcFailure(-32601, "Method not found");
                };
                JsonObject response = new JsonObject(); response.addProperty("jsonrpc", "2.0"); response.add("id", id); response.add("result", result);
                ThriftQueryServer.sendJson(exchange, 200, response.toString());
            } catch (RpcFailure invalid) { rpcError(exchange, id, invalid.code, invalid.getMessage()); }
        } catch (RuntimeException failure) {
            // Never serialize driver/provider exception messages, credentials or headers.
            if (exchange.getResponseCode() < 0) http(exchange, 503, "Layanan MCP atau penyimpanan token tidak tersedia.");
        } finally { exchange.close(); }
    }
    private static boolean accepts(String header, String target) {
        if (header == null) return false;
        for (String range : header.split(",")) {
            String[] parts = range.trim().split(";");
            if (!parts[0].trim().equalsIgnoreCase(target)) continue;
            boolean enabled = true;
            for (int i = 1; i < parts.length; i++) if (parts[i].trim().toLowerCase(Locale.ROOT).startsWith("q=")) {
                try { enabled = Double.parseDouble(parts[i].trim().substring(2)) > 0; } catch (NumberFormatException invalid) { enabled = false; }
            }
            if (enabled) return true;
        }
        return false;
    }
    private static String bearer(HttpExchange exchange) {
        List<String> headers = exchange.getRequestHeaders().get("Authorization");
        if (headers == null || headers.size() != 1) return "";
        String value = headers.get(0);
        return value.matches("(?i)Bearer [A-Za-z0-9_-]{40,200}") ? value.substring(7) : "";
    }
    private static boolean validMessage(JsonObject message, JsonElement id) {
        if (!Set.of("jsonrpc", "id", "method", "params").containsAll(message.keySet())) return false;
        if (!message.has("jsonrpc") || !message.get("jsonrpc").isJsonPrimitive() || !message.get("jsonrpc").getAsJsonPrimitive().isString() || !message.get("jsonrpc").getAsString().equals("2.0")) return false;
        if (!message.has("method") || !message.get("method").isJsonPrimitive() || !message.get("method").getAsJsonPrimitive().isString() || message.get("method").getAsString().isBlank()) return false;
        if (message.has("params") && !message.get("params").isJsonObject()) return false;
        if (id == null) return true;
        return id.isJsonPrimitive() && (id.getAsJsonPrimitive().isString() || id.getAsJsonPrimitive().isNumber() && id.toString().matches("-?(0|[1-9][0-9]*)"));
    }
    private static JsonObject initialize(JsonObject params) {
        try {
            String requested = StrictJson.string(params, "protocolVersion", 30);
            if (!params.has("capabilities") || !params.get("capabilities").isJsonObject() || !params.has("clientInfo") || !params.get("clientInfo").isJsonObject()) throw new IllegalArgumentException();
            StrictJson.string(params.getAsJsonObject("clientInfo"), "name", 200); StrictJson.string(params.getAsJsonObject("clientInfo"), "version", 100);
            JsonObject result = new JsonObject(); result.addProperty("protocolVersion", VERSIONS.contains(requested) ? requested : "2025-11-25");
            result.add("capabilities", StrictJson.object("{\"tools\":{\"listChanged\":false}}"));
            result.add("serverInfo", StrictJson.object("{\"name\":\"GridBase\",\"version\":\"1.3.0\"}"));
            result.addProperty("instructions", "Token akses hanya berlaku pada profil yang diberikan. Jangan mengulang write setelah timeout/hasil tidak pasti. full_access memerlukan persetujuan pengguna di client AI sebelum SQL tulis.");
            return result;
        } catch (IllegalArgumentException invalid) { throw new RpcFailure(-32602, "Invalid initialize params"); }
    }
    private static JsonObject tools(McpTokenStore.Token token, JsonObject params) {
        if (!params.isEmpty()) throw new RpcFailure(-32602, "Pagination/cursor is not supported");
        JsonArray tools = new JsonArray(); boolean readOnly = token.scope().equals("read_only");
        for (String name : List.of("list_connections", "list_databases", "list_tables", "describe_table", "execute_query")) {
            JsonObject tool = new JsonObject(); tool.addProperty("name", name);
            tool.addProperty("description", switch (name) {
                case "list_connections" -> "List approved account-owned saved connections without credentials. Workbench Disconnect does not revoke access.";
                case "list_databases" -> "List databases/schemas from the explicit approved connection.";
                case "list_tables" -> "List tables from the explicit approved connection and namespace.";
                case "describe_table" -> "Describe columns of the explicit approved table.";
                default -> readOnly ? "Execute a supported read-only SELECT/CTE using dedicated read-only credentials." : "Execute one SQL statement. Obtain user approval before writes; UPDATE/DELETE have no browser modal here. Never retry an uncertain write.";
            });
            JsonObject properties = new JsonObject(); JsonArray required = new JsonArray();
            if (!name.equals("list_connections")) { properties.add("connectionId", stringSchema(100)); required.add("connectionId"); }
            if (Set.of("list_tables", "describe_table").contains(name)) { properties.add("namespace", stringSchema(256)); required.add("namespace"); }
            if (name.equals("describe_table")) { properties.add("table", stringSchema(256)); required.add("table"); }
            if (name.equals("execute_query")) { properties.add("sql", stringSchema(20000)); required.add("sql"); }
            JsonObject schema = new JsonObject(); schema.addProperty("type", "object"); schema.add("properties", properties); schema.add("required", required); schema.addProperty("additionalProperties", false); tool.add("inputSchema", schema);
            boolean safe = !name.equals("execute_query") || readOnly;
            JsonObject annotations = new JsonObject(); annotations.addProperty("readOnlyHint", safe); annotations.addProperty("destructiveHint", !safe); annotations.addProperty("idempotentHint", safe); annotations.addProperty("openWorldHint", false); tool.add("annotations", annotations);
            tools.add(tool);
        }
        JsonObject result = new JsonObject(); result.add("tools", tools); return result;
    }
    private static JsonObject stringSchema(int length) { JsonObject schema = new JsonObject(); schema.addProperty("type", "string"); schema.addProperty("minLength", 1); schema.addProperty("maxLength", length); return schema; }

    private JsonObject call(McpTokenStore.Token token, String bearer, JsonObject params) {
        String name; JsonObject args;
        try {
            if (!Set.of("name", "arguments", "_meta").containsAll(params.keySet())) throw new IllegalArgumentException();
            name = StrictJson.string(params, "name", 80);
            if (!TOOLS.contains(name)) throw new IllegalArgumentException();
            if (params.has("arguments") && !params.get("arguments").isJsonObject()) throw new IllegalArgumentException();
            args = params.has("arguments") ? params.getAsJsonObject("arguments") : new JsonObject();
        } catch (IllegalArgumentException invalid) { throw new RpcFailure(-32602, "Invalid tool name/arguments"); }
        String connectionId = null, sql = null;
        try {
            Set<String> keys = switch (name) {
                case "list_connections" -> Set.of(); case "list_databases" -> Set.of("connectionId");
                case "list_tables" -> Set.of("connectionId", "namespace"); case "describe_table" -> Set.of("connectionId", "namespace", "table");
                default -> Set.of("connectionId", "sql");
            };
            if (!keys.equals(args.keySet())) throw new IllegalArgumentException();
            if (!name.equals("list_connections")) {
                connectionId = StrictJson.string(args, "connectionId", 100);
                if (!connectionId.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException();
            }
            if (name.equals("execute_query")) {
                JsonElement value = args.get("sql");
                if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString() || value.getAsString().isBlank() || value.getAsString().length() > 20000) throw new IllegalArgumentException();
                sql = value.getAsString();
            }
            if (keys.contains("namespace")) StrictJson.string(args, "namespace", 256);
            if (keys.contains("table")) StrictJson.string(args, "table", 256);
        } catch (IllegalArgumentException invalid) { return toolError("Parameter tool tidak valid.", null, false); }
        McpAudit.Operation operation;
        String action = switch (name) { case "list_connections" -> "mcp.connections"; case "list_databases" -> "metadata.databases"; case "list_tables" -> "metadata.tables"; case "describe_table" -> "metadata.columns"; default -> "query.execute"; };
        try { operation = audit.start(new GitHubAuth.User(token.ownerId(), token.login()), token.id(), token.name(), action, connectionId, sql); }
        catch (AuditStore.Unavailable unavailable) { return toolError("Audit tidak tersedia; operasi tidak dijalankan.", null, false); }
        JdbcService.QueryResult query = null;
        boolean success = false, denied = false;
        JsonObject data = null; String error = null;
        try {
            var current = tokens.authenticate(bearer);
            if (current == null || !current.id().equals(token.id())) throw new Denied();
            ConnectionRegistry registry = workspaces.forOwner(token.ownerId());
            if (name.equals("list_connections")) {
                JsonArray approved = new JsonArray();
                synchronized (registry) {
                    for (var grant : token.grants()) {
                        try {
                            var profile = authorized(registry, token, grant.connectionId());
                            JsonObject item = new JsonObject(); item.addProperty("id", profile.id()); item.addProperty("name", profile.service().profile().name()); item.addProperty("type", profile.service().profile().type().id()); item.addProperty("readOnly", token.scope().equals("read_only") || grant.readOnly() || profile.readOnly()); approved.add(item);
                        } catch (Denied | ConnectionRegistry.UnknownConnectionException absent) { /* Stale grants do not discover current profiles. */ }
                    }
                }
                data = new JsonObject(); data.add("connections", approved); success = true;
            } else {
                ConnectionRegistry.McpProfile profile;
                synchronized (registry) { profile = authorized(registry, token, connectionId); }
                boolean readOnly = token.scope().equals("read_only") || profile.readOnly() || token.grants().stream().filter(g -> g.connectionId().equals(profile.id())).findFirst().orElseThrow().readOnly();
                if (name.equals("execute_query")) {
                    if (readOnly) McpSqlPolicy.validate(sql, profile.service().profile().type());
                    else { var policy = SqlPolicy.validate(sql, 20000); if (!policy.ok()) throw new IllegalArgumentException(); sql = policy.sql(); }
                }
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(config.timeoutSeconds);
                JdbcService jdbc = profile.service().forMcp(new McpExecutionPolicy(profile.generation(), readOnly, 500, 1000, deadline));
                String submittedSql = sql;
                Future<ToolData> future = workers.submit(() -> {
                    // Revalidate immediately before entering the immutable JDBC view, after scheduling.
                    if (tokens.authenticate(bearer) == null) throw new Denied();
                    synchronized (registry) { var now = authorized(registry, token, profile.id()); if (!now.generation().equals(profile.generation())) throw new Denied(); }
                    return databaseTool(name, args, jdbc, submittedSql);
                });
                try {
                    ToolData result = future.get(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS); data = result.data(); query = result.query(); success = true;
                } catch (TimeoutException timeout) { future.cancel(true); error = "Batas waktu MCP terlewati. Hasil operasi mungkin belum diketahui; jangan mengulang write secara otomatis."; }
                catch (InterruptedException interrupted) { future.cancel(true); Thread.currentThread().interrupt(); error = "Request dihentikan; hasil operasi mungkin belum diketahui."; }
            }
        } catch (Denied | ConnectionRegistry.UnknownConnectionException forbidden) { denied = true; error = "Akses koneksi ditolak atau grant berubah. Buat token pengganti jika profil diubah."; }
        catch (IllegalArgumentException invalid) { denied = true; error = "SQL atau parameter tidak didukung oleh kebijakan token. Gunakan subset read-only yang didokumentasikan."; }
        catch (RejectedExecutionException busy) { error = "Kapasitas MCP penuh; operasi ini tidak dijalankan."; }
        catch (ExecutionException failure) { denied = failure.getCause() instanceof Denied; error = denied ? "Akses koneksi telah dicabut atau berubah." : "Operasi database gagal. Periksa koneksi, izin, dan driver; jangan mengulang write dengan hasil tidak pasti."; }
        catch (RuntimeException unavailable) { error = "Penyimpanan atau layanan MCP tidak tersedia."; }
        boolean incomplete = operation.complete(success, denied, query);
        return success ? toolResult(data, false, operation.requestId(), incomplete) : toolError(error, operation.requestId(), incomplete);
    }
    private static ConnectionRegistry.McpProfile authorized(ConnectionRegistry registry, McpTokenStore.Token token, String id) {
        var grant = token.grants().stream().filter(g -> g.connectionId().equals(id)).findFirst().orElseThrow(Denied::new);
        var profile = registry.mcp(id);
        if (!grant.generation().equals(profile.generation()) || token.scope().equals("read_only") && (!grant.readOnly() || !profile.readOnly())) throw new Denied();
        return profile;
    }
    private static ToolData databaseTool(String name, JsonObject args, JdbcService jdbc, String sql) throws Exception {
        JsonObject data = new JsonObject();
        if (name.equals("execute_query")) { var query = jdbc.query(sql); return new ToolData(JsonParser.parseString(query.toJson()).getAsJsonObject(), query); }
        JsonArray values = new JsonArray();
        switch (name) {
            case "list_databases" -> jdbc.databases().forEach(values::add);
            case "list_tables" -> jdbc.tables(args.get("namespace").getAsString()).forEach(values::add);
            case "describe_table" -> jdbc.columns(args.get("namespace").getAsString(), args.get("table").getAsString()).forEach(column -> values.add(JsonParser.parseString(column.toJson())));
            default -> throw new IllegalArgumentException();
        }
        data.add(name.equals("describe_table") ? "columns" : name.equals("list_tables") ? "tables" : "databases", values);
        data.addProperty("truncated", jdbc.metadataTruncated()); return new ToolData(data, null);
    }
    private static JsonObject toolError(String message, String requestId, boolean incomplete) { JsonObject data = new JsonObject(); data.addProperty("error", message); return toolResult(data, true, requestId, incomplete); }
    private static JsonObject toolResult(JsonObject data, boolean error, String requestId, boolean incomplete) {
        JsonObject meta = new JsonObject(); if (requestId != null) meta.addProperty("requestId", requestId); meta.addProperty("auditIncomplete", incomplete);
        data.add("_meta", meta.deepCopy());
        JsonObject result = new JsonObject(); result.addProperty("isError", error); result.add("_meta", meta);
        JsonArray content = new JsonArray(); JsonObject text = new JsonObject(); text.addProperty("type", "text"); text.addProperty("text", data.toString()); content.add(text); result.add("content", content);
        if (result.toString().getBytes(StandardCharsets.UTF_8).length > MAX_RESPONSE - 2048) {
            // Preserve the actual query outcome and update count; report omitted oversized data, never a fabricated SQL failure.
            JsonObject summary = new JsonObject(); summary.addProperty("truncated", true); summary.addProperty("responseOmitted", true); summary.addProperty("reason", "MCP response exceeds 1 MiB");
            for (String key : List.of("updateCount", "rowCount", "durationMs", "_meta")) if (data.has(key)) summary.add(key, data.get(key));
            text.addProperty("text", summary.toString());
        }
        return result;
    }
    private static void noContent(HttpExchange exchange) throws IOException { ThriftQueryServer.applySecurityHeaders(exchange.getResponseHeaders()); exchange.getResponseHeaders().set("Cache-Control", "no-store"); exchange.sendResponseHeaders(202, -1); }
    private static void http(HttpExchange exchange, int status, String message) throws IOException { ThriftQueryServer.sendJson(exchange, status, "{\"error\":" + JsonUtil.quote(message) + "}"); }
    private static void rpcError(HttpExchange exchange, JsonElement id, int code, String message) throws IOException {
        JsonObject response = new JsonObject(); response.addProperty("jsonrpc", "2.0"); response.add("id", id); JsonObject error = new JsonObject(); error.addProperty("code", code); error.addProperty("message", message); response.add("error", error); ThriftQueryServer.sendJson(exchange, 200, response.toString());
    }
    private record ToolData(JsonObject data, JdbcService.QueryResult query) { }
    private static final class Denied extends RuntimeException { }
    private static final class RpcFailure extends RuntimeException { final int code; RpcFailure(int code, String message) { super(message); this.code = code; } }
}
