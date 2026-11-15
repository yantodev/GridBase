package com.peentar.thriftquery;

import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.util.Set;

final class ActivityApi {
    private final ActivityAudit audit;
    ActivityApi(ActivityAudit audit) { this.audit = audit; }
    void handle(HttpExchange exchange, GitHubAuth.User actor) throws IOException {
        String path = exchange.getRequestURI().getPath(), method = exchange.getRequestMethod();
        try {
            if (path.equals("/api/activity") && method.equals("GET")) {
                ThriftQueryServer.sendJson(exchange, 200, audit.store.list(actor.id(), audit.admin(actor), GitHubAuth.params(exchange.getRequestURI().getRawQuery())).toJson());
            } else if (path.equals("/api/activity/users") && method.equals("GET")) {
                if (!audit.admin(actor)) throw new AuditStore.Forbidden();
                ThriftQueryServer.sendJson(exchange, 200, audit.store.users());
            } else if (path.equals("/api/activity/exports") && method.equals("POST")) {
                String body = ThriftQueryServer.readBody(exchange);
                String reference = JsonUtil.stringField(body, "queryRequestId"), format = JsonUtil.stringField(body, "format");
                long rows = JsonUtil.nonnegativeLongField(body, "rowCount");
                if (!Set.of("csv", "json").contains(format)) throw new IllegalArgumentException();
                AuditStore.Event query = audit.store.ownedQuery(reference, actor.id());
                if (query == null) { jsonError(exchange, 404, "Eksekusi query tidak ditemukan."); return; }
                if (query.returnedRows == null || rows > query.returnedRows) throw new IllegalArgumentException();
                ActivityAudit.export(exchange, query, format, rows);
                ThriftQueryServer.sendJson(exchange, 200, "{\"ok\":true,\"requestId\":" + JsonUtil.quote(ActivityAudit.requestId(exchange)) + "}");
            } else if (Set.of("/api/activity", "/api/activity/users", "/api/activity/exports").contains(path)) {
                jsonError(exchange, 405, "Method tidak didukung.");
            } else jsonError(exchange, 404, "Endpoint tidak ditemukan.");
        } catch (AuditStore.Forbidden forbidden) { jsonError(exchange, 403, forbidden.getMessage()); }
        catch (IllegalArgumentException invalid) { jsonError(exchange, 400, "Filter atau data aktivitas tidak valid."); }
    }
    private static void jsonError(HttpExchange exchange, int status, String message) throws IOException {
        ThriftQueryServer.sendJson(exchange, status, "{\"error\":" + JsonUtil.quote(message) + "}");
    }
}
