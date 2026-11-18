package com.peentar.thriftquery;

import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Set;

/** Per-launch native-host capability. Never a browser session or an MCP credential. */
final class LocalAuth implements RequestAuth {
    private static final String SCHEME = "GridBase-Local ";
    private final byte[] capability;
    private final Actor owner;
    private final java.util.function.BooleanSupplier mcpEnabled;

    LocalAuth(byte[] capability, Actor owner) { this(capability, owner, () -> false); }
    private LocalAuth(byte[] capability, Actor owner, java.util.function.BooleanSupplier mcpEnabled) {
        if (capability == null || capability.length != 32 || owner == null || !owner.provider().equals("local"))
            throw new IllegalArgumentException("Invalid local authentication configuration.");
        this.capability = capability.clone();
        this.owner = owner;
        this.mcpEnabled = java.util.Objects.requireNonNull(mcpEnabled);
    }
    LocalAuth withMcp(LocalMcpControl control) { return new LocalAuth(capability, owner, control::enabled); }
    boolean owns(Actor actor) { return owner.equals(actor); }
    Actor owner() { return owner; }
    @Override public Actor actor(HttpExchange exchange) { return authorized(exchange) ? owner : null; }

    private boolean authorized(HttpExchange exchange) {
        if (exchange.getRemoteAddress() == null || exchange.getRemoteAddress().getAddress() == null
                || !exchange.getRemoteAddress().getAddress().isLoopbackAddress()
                || exchange.getLocalAddress() == null || exchange.getLocalAddress().getAddress() == null
                || !exchange.getLocalAddress().getAddress().isLoopbackAddress()
                || exchange.getRequestHeaders().containsKey("Origin")) return false;
        var values = exchange.getRequestHeaders().get("Authorization");
        if (values == null || values.size() != 1 || !values.get(0).startsWith(SCHEME)) return false;
        try { return MessageDigest.isEqual(capability, decodeSecret(values.get(0).substring(SCHEME.length()))); }
        catch (IllegalArgumentException invalid) { return false; }
    }
    static byte[] decodeSecret(String text) {
        if (text == null || !text.matches("[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException("Invalid local secret.");
        byte[] bytes = Base64.getUrlDecoder().decode(text);
        if (bytes.length != 32 || !Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).equals(text))
            throw new IllegalArgumentException("Invalid local secret.");
        return bytes;
    }
    @Override public boolean handle(HttpExchange exchange, Set<String> auditAdmins) throws IOException {
        if (!authorized(exchange)) return error(exchange, 401, "Local authorization required.");
        String path = exchange.getRequestURI().getPath();
        if (path.equals("/api/auth/session") || path.equals("/healthz")) {
            if (!exchange.getRequestMethod().equals("GET")) return error(exchange, 405, "Method not supported.");
            String body = path.equals("/healthz") ? "{\"status\":\"ok\"}"
                    : "{\"authenticated\":true,\"mode\":\"local\",\"user\":{\"id\":" + JsonUtil.quote(owner.ownerKey())
                    + ",\"login\":\"Local\",\"provider\":\"local\"},\"capabilities\":{\"auditAdmin\":false,\"mcpEnabled\":" + mcpEnabled.getAsBoolean() + "}}";
            ThriftQueryServer.sendJson(exchange, 200, body); return true;
        }
        if (Set.of("/api/health", "/api/query", "/api/databases", "/api/namespaces", "/api/tables", "/api/columns", "/api/connections", "/api/activity").contains(path)
                || path.equals("/api/local/mcp") || path.equals("/api/mcp/tokens") || path.matches("/api/mcp/tokens/[0-9a-f-]{36}")
                || path.startsWith("/api/connections/") || path.startsWith("/api/activity/")) return false;
        return error(exchange, 404, "Endpoint not found.");
    }
    private static boolean error(HttpExchange exchange, int status, String message) throws IOException {
        ThriftQueryServer.sendJson(exchange, status, "{\"error\":" + JsonUtil.quote(message) + "}"); return true;
    }
    @Override public String toString() { return "LocalAuth[REDACTED]"; }
}
