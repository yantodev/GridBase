package com.peentar.thriftquery;

import com.sun.net.httpserver.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Request-local state: HttpContext attributes are shared and must never hold an actor. */
final class ActivityAudit {
    final AuditStore store;
    private final Set<String> admins;
    ActivityAudit(AppConfig config) { store = new AuditStore(config.dataDir); admins = config.auditAdminIds; }
    boolean admin(GitHubAuth.User actor) { return actor != null && admins.contains(actor.id()); }
    Exchange wrap(HttpExchange exchange, GitHubAuth.User actor) { return new Exchange(exchange, actor); }

    private static String action(HttpExchange exchange) {
        String path = exchange.getRequestURI().getPath(), method = exchange.getRequestMethod();
        return switch (path) {
            case "/auth/github" -> "auth.start";
            case "/auth/github/callback" -> "auth.login";
            case "/auth/logout" -> "auth.logout";
            case "/api/connections" -> method.equals("GET") ? "connection.list" : "connection.save";
            case "/api/connections/test", "/api/connections/connect", "/api/connections/disconnect" -> method.equals("POST")
                    ? "connection." + path.substring("/api/connections/".length())
                    : method.equals("DELETE") ? "connection.delete" : "connection.details";
            case "/api/query" -> "query.execute";
            case "/api/databases" -> "metadata.databases";
            case "/api/namespaces" -> "metadata.namespaces";
            case "/api/tables" -> "metadata.tables";
            case "/api/columns" -> "metadata.columns";
            case "/api/activity/exports" -> "result.export_requested";
            default -> path.matches("/api/connections/[a-zA-Z0-9_-]{1,100}")
                    ? (method.equals("DELETE") ? "connection.delete" : "connection.details") : null;
        };
    }
    static void actor(HttpExchange exchange, GitHubAuth.User actor) {
        if (exchange instanceof ActivityAudit.Exchange audited && audited.event != null) audited.event.actor(actor);
    }
    static String requestId(HttpExchange exchange) { return ((ActivityAudit.Exchange) exchange).requestId; }
    static void connection(HttpExchange exchange, String id) {
        Exchange context = (Exchange) exchange;
        if (id != null && !id.isBlank() && !id.matches("[a-zA-Z0-9_-]{1,100}")) throw new IllegalArgumentException("ID koneksi tidak valid.");
        if (context.event != null) { context.event.connectionId = id == null || id.isBlank() ? null : id; context.annotate(); }
    }
    static void sql(HttpExchange exchange, String sql) {
        Exchange context = (Exchange) exchange;
        if (context.event == null) return;
        try {
            context.event.sqlHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(sql.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
        String masked = SqlPolicy.maskQuotedSql(sql).stripLeading().toUpperCase(Locale.ROOT);
        var verb = java.util.regex.Pattern.compile("^([A-Z]+)\\b").matcher(masked);
        context.event.sqlOperation = verb.find() && AuditStore.OPERATIONS.contains(verb.group(1)) ? verb.group(1) : null;
        context.annotate();
    }
    static void result(HttpExchange exchange, JdbcService.QueryResult result) {
        Exchange context = (Exchange) exchange;
        context.event.returnedRows = (long) result.rows().size(); context.event.affectedRows = result.updateCount();
    }
    static void export(HttpExchange exchange, AuditStore.Event query, String format, long count) {
        Exchange context = (Exchange) exchange;
        context.event.connectionId = query.connectionId; context.event.queryRequestId = query.requestId;
        context.event.exportFormat = format; context.event.returnedRows = count; context.annotate();
    }

    final class Exchange extends HttpExchange {
        private final HttpExchange delegate;
        final AuditStore.Event event;
        final String requestId;
        private final long startedNanos = System.nanoTime();
        private boolean begun, completed, disabled;
        Exchange(HttpExchange delegate, GitHubAuth.User actor) {
            this.delegate = delegate;
            String action = action(delegate);
            event = action == null ? null : new AuditStore.Event("auth.login".equals(action) ? null : actor, action, action.equals("result.export_requested") ? "browser" : "server");
            requestId = event == null ? UUID.randomUUID().toString() : event.requestId;
        }
        void beginOperation() {
            if (event == null || event.action.startsWith("auth.") || begun) return;
            try { store.begin(event); begun = true; }
            catch (AuditStore.Unavailable unavailable) { disabled = true; throw unavailable; }
        }
        void annotate() { if (begun) store.annotate(event); }
        private void complete(int status) {
            if (completed) return;
            completed = true;
            if (event == null || disabled) return;
            try {
                if (!begun) { store.begin(event); begun = true; }
                String location = getResponseHeaders().getFirst("Location");
                String authError = location != null && location.startsWith("/login?error=") ? location.substring("/login?error=".length()) : null;
                event.outcome = status == 401 || status == 403 || status == 409 || Set.of("denied", "not_allowed").contains(authError == null ? "" : authError) ? "denied" : status >= 400 || authError != null ? "failure" : "success";
                event.code = authError != null && Set.of("invalid_state", "failed", "denied", "not_allowed", "busy", "not_configured").contains(authError)
                        ? "AUTH_" + authError.toUpperCase(Locale.ROOT) : status >= 300 && status != 303 ? "HTTP_" + status : status >= 400 ? "HTTP_" + status : "OK";
                event.finishedAt = System.currentTimeMillis(); event.durationMs = Math.max(0, (System.nanoTime() - startedNanos) / 1_000_000); event.httpStatus = status;
                store.finish(event);
            } catch (AuditStore.Unavailable failure) {
                getResponseHeaders().set("X-GridBase-Audit-Warning", "incomplete");
                System.err.println("Audit persistence incomplete requestId=" + requestId);
            }
        }
        @Override public void sendResponseHeaders(int status, long length) throws IOException {
            getResponseHeaders().set("X-Request-ID", requestId); complete(status); delegate.sendResponseHeaders(status, length);
        }
        @Override public Headers getRequestHeaders() { return delegate.getRequestHeaders(); }
        @Override public Headers getResponseHeaders() { return delegate.getResponseHeaders(); }
        @Override public URI getRequestURI() { return delegate.getRequestURI(); }
        @Override public String getRequestMethod() { return delegate.getRequestMethod(); }
        @Override public HttpContext getHttpContext() { return delegate.getHttpContext(); }
        @Override public void close() { delegate.close(); }
        @Override public InputStream getRequestBody() { return delegate.getRequestBody(); }
        @Override public OutputStream getResponseBody() { return delegate.getResponseBody(); }
        @Override public InetSocketAddress getRemoteAddress() { return delegate.getRemoteAddress(); }
        @Override public InetSocketAddress getLocalAddress() { return delegate.getLocalAddress(); }
        @Override public String getProtocol() { return delegate.getProtocol(); }
        @Override public Object getAttribute(String name) { return delegate.getAttribute(name); }
        @Override public void setAttribute(String name, Object value) { delegate.setAttribute(name, value); }
        @Override public void setStreams(InputStream input, OutputStream output) { delegate.setStreams(input, output); }
        @Override public HttpPrincipal getPrincipal() { return delegate.getPrincipal(); }
        @Override public int getResponseCode() { return delegate.getResponseCode(); }
    }
}
