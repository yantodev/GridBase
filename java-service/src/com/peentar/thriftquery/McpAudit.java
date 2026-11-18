package com.peentar.thriftquery;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Pattern;

/** Explicit tool lifecycle: MCP HTTP 200 is transport success, not SQL success. */
final class McpAudit {
    private static final Pattern SQL_VERB = Pattern.compile("^([A-Z]+)\\b");
    private final AuditStore store;

    McpAudit(AuditStore store) { this.store = Objects.requireNonNull(store); }

    /** Only nonsecret token ID/name snapshots belong here, never a bearer token. */
    Operation start(GitHubAuth.User actor, String tokenId, String tokenName, String action, String connectionId, String sql) {
        return start(actor == null ? null : actor.toActor(), tokenId, tokenName, action, connectionId, sql);
    }

    Operation start(Actor actor, String tokenId, String tokenName, String action, String connectionId, String sql) {
        var event = new AuditStore.Event(actor, action, "mcp");
        event.tokenId = tokenId;
        event.tokenName = tokenName;
        event.connectionId = connectionId;
        if (sql != null) {
            event.sqlText = sql;
            try {
                event.sqlHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(sql.getBytes(StandardCharsets.UTF_8)));
            } catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
            var verb = SQL_VERB.matcher(SqlPolicy.maskQuotedSql(sql).stripLeading().toUpperCase(Locale.ROOT));
            event.sqlOperation = verb.find() && AuditStore.OPERATIONS.contains(verb.group(1)) ? verb.group(1) : null;
        }
        // One durable insert includes target, identity and full SQL before any JDBC work.
        var operation = new Operation(event);
        store.begin(event);
        return operation;
    }

    final class Operation {
        private final AuditStore.Event event;
        private final long startedNanos = System.nanoTime();
        private boolean completed, auditIncomplete;

        private Operation(AuditStore.Event event) { this.event = event; }

        String requestId() { return event.requestId; }

        /** Returns auditIncomplete without changing/discarding the actual tool result. */
        synchronized boolean complete(boolean success, boolean denied, JdbcService.QueryResult result) {
            if (completed) return auditIncomplete;
            completed = true;
            event.outcome = denied ? "denied" : success ? "success" : "failure";
            event.code = denied ? "HTTP_403" : success ? "OK" : "HTTP_502";
            event.httpStatus = 200;
            event.finishedAt = System.currentTimeMillis();
            event.durationMs = Math.max(0, (System.nanoTime() - startedNanos) / 1_000_000);
            if (result != null) {
                event.returnedRows = (long) result.rows().size();
                event.affectedRows = result.updateCount();
            }
            try { store.finish(event); }
            catch (AuditStore.Unavailable unavailable) { auditIncomplete = true; }
            return auditIncomplete;
        }
    }
}
