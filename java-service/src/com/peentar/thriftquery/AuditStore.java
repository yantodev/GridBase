package com.peentar.thriftquery;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Operational metadata and submitted query SQL. No connection credentials or results. */
final class AuditStore {
    static final Set<String> ACTIONS = Set.of("auth.start", "auth.login", "auth.logout", "connection.list", "connection.save", "connection.test", "connection.connect", "connection.details", "connection.disconnect", "connection.delete", "query.execute", "metadata.databases", "metadata.namespaces", "metadata.tables", "metadata.columns", "result.export_requested", "mcp.connections", "token.create", "token.revoke");
    private static final Set<String> MCP_ACTIONS = Set.of("mcp.connections", "query.execute", "metadata.databases", "metadata.namespaces", "metadata.tables", "metadata.columns");
    static final Set<String> OPERATIONS = Set.of("SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "CREATE", "INSERT", "UPDATE", "DELETE", "MERGE", "ALTER", "DROP", "TRUNCATE");
    private static final Set<String> OUTCOMES = Set.of("pending", "success", "failure", "denied");
    private static final Set<String> FILTERS = Set.of("scope", "userId", "from", "to", "action", "outcome", "connectionId", "cursor", "limit");
    private final Path database;

    AuditStore(Path dataDir) {
        database = dataDir.toAbsolutePath().normalize().resolve("audit.sqlite");
        synchronized (AuditStore.class) {
            try {
                Class.forName("org.sqlite.JDBC");
                PrivateFiles.database(database);
                try (var db = open(); var sql = db.createStatement()) {
                    int schema;
                    try (var version = sql.executeQuery("PRAGMA user_version")) { schema = version.next() ? version.getInt(1) : -1; }
                    if (schema < 0 || schema > 3) throw new Unavailable();
                    sql.execute("PRAGMA journal_mode=WAL");
                    db.setAutoCommit(false);
                    sql.executeUpdate("CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL, user_id TEXT, login TEXT, action TEXT NOT NULL, source TEXT NOT NULL, connection_id TEXT, sql_operation TEXT, sql_hash TEXT, query_request_id TEXT, export_format TEXT, returned_rows INTEGER, affected_rows INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, duration_ms INTEGER, http_status INTEGER, outcome TEXT NOT NULL, code TEXT, sql_text TEXT, token_id TEXT, token_name TEXT)");
                    if (schema < 2) {
                        boolean hasSqlText = false;
                        try (var columns = sql.executeQuery("PRAGMA table_info(audit_events)")) { while (columns.next()) if (columns.getString("name").equals("sql_text")) hasSqlText = true; }
                        if (!hasSqlText) sql.executeUpdate("ALTER TABLE audit_events ADD COLUMN sql_text TEXT");
                    }
                    if (schema < 3) {
                        Set<String> columns = new java.util.HashSet<>();
                        try (var rows = sql.executeQuery("PRAGMA table_info(audit_events)")) { while (rows.next()) columns.add(rows.getString("name")); }
                        if (!columns.contains("token_id")) sql.executeUpdate("ALTER TABLE audit_events ADD COLUMN token_id TEXT");
                        if (!columns.contains("token_name")) sql.executeUpdate("ALTER TABLE audit_events ADD COLUMN token_name TEXT");
                    }
                    sql.executeUpdate("CREATE INDEX IF NOT EXISTS audit_owner_order ON audit_events(user_id,id DESC)");
                    sql.executeUpdate("CREATE INDEX IF NOT EXISTS audit_started ON audit_events(started_at)");
                    sql.executeUpdate("CREATE INDEX IF NOT EXISTS audit_action_order ON audit_events(action,id DESC)");
                    sql.executeUpdate("PRAGMA user_version=3");
                    db.commit();
                }
            } catch (Exception error) { throw new Unavailable(); }
        }
    }

    synchronized void begin(Event event) {
        validate(event);
        if (!event.outcome.equals("pending") || event.finishedAt != null) throw new IllegalArgumentException("Invalid pending audit");
        try (var db = open(); var sql = db.prepareStatement("INSERT INTO audit_events(request_id,user_id,login,action,source,connection_id,sql_operation,sql_hash,query_request_id,export_format,returned_rows,affected_rows,sql_text,started_at,outcome,token_id,token_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
            sql.setString(1, event.requestId); sql.setString(2, event.userId); sql.setString(3, event.login); sql.setString(4, event.action); sql.setString(5, event.source);
            bindMetadata(sql, 6, event); sql.setLong(14, event.startedAt); sql.setString(15, "pending"); sql.setString(16, event.tokenId); sql.setString(17, event.tokenName);
            sql.executeUpdate();
        } catch (Exception error) { throw new Unavailable(); }
    }

    synchronized void annotate(Event event) {
        validate(event);
        try (var db = open(); var sql = db.prepareStatement("UPDATE audit_events SET connection_id=?,sql_operation=?,sql_hash=?,query_request_id=?,export_format=?,returned_rows=?,affected_rows=?,sql_text=? WHERE request_id=? AND outcome='pending'")) {
            bindMetadata(sql, 1, event); sql.setString(9, event.requestId);
            if (sql.executeUpdate() != 1) throw new Unavailable();
        } catch (Exception error) { throw new Unavailable(); }
    }

    synchronized void finish(Event event) {
        validate(event);
        if (event.finishedAt == null || event.outcome.equals("pending") || event.durationMs == null || event.durationMs < 0 || event.httpStatus == null || event.httpStatus < 100 || event.httpStatus > 599) throw new IllegalArgumentException("Invalid finished audit");
        try (var db = open(); var sql = db.prepareStatement("UPDATE audit_events SET connection_id=?,sql_operation=?,sql_hash=?,query_request_id=?,export_format=?,returned_rows=?,affected_rows=?,sql_text=?,user_id=?,login=?,finished_at=?,duration_ms=?,http_status=?,outcome=?,code=? WHERE request_id=? AND outcome='pending'")) {
            bindMetadata(sql, 1, event); sql.setString(9, event.userId); sql.setString(10, event.login); sql.setLong(11, event.finishedAt); sql.setLong(12, event.durationMs); sql.setInt(13, event.httpStatus); sql.setString(14, event.outcome); sql.setString(15, event.code); sql.setString(16, event.requestId);
            if (sql.executeUpdate() != 1) throw new Unavailable();
        } catch (Exception error) { throw new Unavailable(); }
    }

    Page list(String ownerId, boolean admin, Map<String, String> filters) {
        Actor.validOwnerKey(ownerId);
        admin = admin && !ownerId.startsWith("local:"); // Server audit administrator IDs are GitHub-only.
        if (!FILTERS.containsAll(filters.keySet())) throw new IllegalArgumentException("Filter aktivitas tidak dikenal.");
        String scope = filters.getOrDefault("scope", "mine");
        if (!scope.equals("mine") && !scope.equals("all")) throw new IllegalArgumentException("Scope aktivitas tidak valid.");
        if ((scope.equals("all") || filters.containsKey("userId")) && !admin) throw new Forbidden();
        if (filters.containsKey("userId") && !scope.equals("all")) throw new IllegalArgumentException("Filter akun memerlukan scope seluruh pengguna.");
        String actor = scope.equals("mine") ? ownerId : filters.get("userId");
        if (actor != null) Actor.validOwnerKey(actor);
        int limit = filters.containsKey("limit") ? (int) positive(filters.get("limit"), 100) : 50;
        List<Object> values = new ArrayList<>(); StringBuilder where = new StringBuilder(" WHERE 1=1");
        if (actor != null) condition(where, values, "user_id=?", actor);
        if (filters.containsKey("cursor")) condition(where, values, "id<?", positive(filters.get("cursor"), Long.MAX_VALUE));
        Long from = filters.containsKey("from") ? instant(filters.get("from")) : null;
        Long to = filters.containsKey("to") ? instant(filters.get("to")) : null;
        if (from != null && to != null && from > to) throw new IllegalArgumentException("Rentang waktu tidak valid.");
        if (from != null) condition(where, values, "started_at>=?", from);
        if (to != null) condition(where, values, "started_at<=?", to);
        for (String key : List.of("action", "outcome", "connectionId")) if (filters.containsKey(key)) {
            String value = filters.get(key);
            if (key.equals("action") && !ACTIONS.contains(value) || key.equals("outcome") && !OUTCOMES.contains(value) || key.equals("connectionId") && !value.matches("[a-zA-Z0-9_-]{1,100}")) throw new IllegalArgumentException("Filter aktivitas tidak valid.");
            condition(where, values, (key.equals("connectionId") ? "connection_id" : key) + "=?", value);
        }
        try (var db = open(); var sql = db.prepareStatement("SELECT * FROM audit_events" + where + " ORDER BY id DESC LIMIT ?")) {
            int i = 1; for (Object value : values) sql.setObject(i++, value); sql.setInt(i, limit + 1);
            List<Event> events = new ArrayList<>(); try (var rows = sql.executeQuery()) { while (rows.next()) events.add(read(rows)); }
            String cursor = null;
            if (events.size() > limit) { events.remove(events.size() - 1); cursor = Long.toString(events.get(events.size() - 1).id); }
            return new Page(List.copyOf(events), cursor, admin);
        } catch (Exception error) { throw new Unavailable(); }
    }

    Event ownedQuery(String requestId, String ownerId) {
        if (requestId == null || !requestId.matches("[0-9a-f-]{36}")) return null;
        Actor.validOwnerKey(ownerId);
        try (var db = open(); var sql = db.prepareStatement("SELECT * FROM audit_events WHERE request_id=? AND user_id=? AND action='query.execute' AND outcome='success'")) {
            sql.setString(1, requestId); sql.setString(2, ownerId);
            try (var rows = sql.executeQuery()) { return rows.next() ? read(rows) : null; }
        } catch (Exception error) { throw new Unavailable(); }
    }

    String users() {
        try (var db = open(); var sql = db.createStatement(); var rows = sql.executeQuery("SELECT a.user_id,a.login FROM audit_events a JOIN (SELECT user_id,MAX(id) AS id FROM audit_events WHERE user_id IS NOT NULL GROUP BY user_id) latest ON a.id=latest.id ORDER BY a.login,a.user_id")) {
            List<String> users = new ArrayList<>(); while (rows.next()) users.add("{\"id\":" + JsonUtil.quote(rows.getString(1)) + ",\"login\":" + JsonUtil.quote(rows.getString(2)) + "}");
            return "{\"users\":[" + String.join(",", users) + "]}";
        } catch (Exception error) { throw new Unavailable(); }
    }

    private static void condition(StringBuilder where, List<Object> values, String expression, Object value) { where.append(" AND ").append(expression); values.add(value); }
    private static long instant(String value) {
        try { if (!value.endsWith("Z")) throw new IllegalArgumentException(); return Instant.parse(value).toEpochMilli(); } catch (Exception invalid) { throw new IllegalArgumentException("Waktu harus berupa ISO 8601 UTC."); }
    }
    private static long positive(String value, long maximum) {
        try { if (!value.matches("[1-9][0-9]{0,18}")) throw new NumberFormatException(); long n = Long.parseLong(value); if (n > maximum) throw new NumberFormatException(); return n; }
        catch (NumberFormatException invalid) { throw new IllegalArgumentException("Batas atau cursor aktivitas tidak valid."); }
    }
    private static void validate(Event event) {
        if (!event.requestId.matches("[0-9a-f-]{36}") || !ACTIONS.contains(event.action) || !OUTCOMES.contains(event.outcome)) throw new IllegalArgumentException("Invalid audit event");
        Actor actor = event.userId == null ? null : Actor.fromOwnerKey(event.userId, event.login);
        if (actor == null && event.login != null) throw new IllegalArgumentException("Unverified actor");
        if ("mcp".equals(event.source)) {
            if (!MCP_ACTIONS.contains(event.action) || event.userId == null || event.tokenId == null || event.tokenName == null) throw new IllegalArgumentException("Invalid MCP audit identity or action");
        } else {
            boolean localSource = "desktop".equals(event.source) || "vscode".equals(event.source);
            boolean localActor = actor != null && actor.provider().equals("local");
            if (event.action.equals("mcp.connections")) throw new IllegalArgumentException("Invalid event source");
            if (localSource) {
                if (!localActor) throw new IllegalArgumentException("Local source requires a local actor");
            } else {
                String expectedSource = event.action.equals("result.export_requested") ? "browser" : "server";
                if (localActor || !expectedSource.equals(event.source)) throw new IllegalArgumentException("Invalid event source");
            }
        }
        if ((event.tokenId == null) != (event.tokenName == null)
                || event.tokenId != null && (!event.tokenId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}") || event.tokenName.isBlank() || event.tokenName.length() > 100 || event.tokenName.codePoints().anyMatch(Character::isISOControl)
                    || !("mcp".equals(event.source) || Set.of("token.create", "token.revoke").contains(event.action)))) throw new IllegalArgumentException("Invalid token audit identity");
        if (event.connectionId != null && !event.connectionId.matches("[a-zA-Z0-9_-]{1,100}")) throw new IllegalArgumentException("Invalid connection reference");
        if (event.sqlOperation != null && !OPERATIONS.contains(event.sqlOperation) || event.sqlHash != null && !event.sqlHash.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid SQL metadata");
        if (event.sqlText != null && !event.action.equals("query.execute")) throw new IllegalArgumentException("SQL text requires query activity");
        if (event.queryRequestId != null && !event.queryRequestId.matches("[0-9a-f-]{36}") || event.exportFormat != null && !Set.of("csv", "json").contains(event.exportFormat)) throw new IllegalArgumentException("Invalid export metadata");
        if (event.returnedRows != null && event.returnedRows < 0 || event.affectedRows != null && event.affectedRows < 0) throw new IllegalArgumentException("Invalid row count");
        if (event.code != null && !(event.code.equals("OK") || event.code.matches("HTTP_[345][0-9]{2}") || Set.of("AUTH_INVALID_STATE", "AUTH_FAILED", "AUTH_DENIED", "AUTH_NOT_ALLOWED", "AUTH_BUSY", "AUTH_NOT_CONFIGURED").contains(event.code))) throw new IllegalArgumentException("Invalid safe outcome code");
    }
    private static void bindMetadata(PreparedStatement sql, int index, Event event) throws Exception {
        sql.setString(index++, event.connectionId); sql.setString(index++, event.sqlOperation); sql.setString(index++, event.sqlHash); sql.setString(index++, event.queryRequestId); sql.setString(index++, event.exportFormat); sql.setObject(index++, event.returnedRows); sql.setObject(index++, event.affectedRows); sql.setString(index, event.sqlText);
    }
    private static Event read(ResultSet rows) throws Exception {
        Event e = new Event(); e.sqlText = rows.getString("sql_text"); e.tokenId = rows.getString("token_id"); e.tokenName = rows.getString("token_name"); e.id = rows.getLong("id"); e.requestId = rows.getString("request_id"); e.userId = rows.getString("user_id"); e.login = rows.getString("login"); e.action = rows.getString("action"); e.source = rows.getString("source"); e.connectionId = rows.getString("connection_id"); e.sqlOperation = rows.getString("sql_operation"); e.sqlHash = rows.getString("sql_hash"); e.queryRequestId = rows.getString("query_request_id"); e.exportFormat = rows.getString("export_format"); e.returnedRows = nullableLong(rows,"returned_rows"); e.affectedRows = nullableLong(rows,"affected_rows"); e.startedAt = rows.getLong("started_at"); e.finishedAt = nullableLong(rows,"finished_at"); e.durationMs = nullableLong(rows,"duration_ms"); var status = nullableLong(rows,"http_status"); e.httpStatus = status == null ? null : status.intValue(); e.outcome = rows.getString("outcome"); e.code = rows.getString("code"); return e;
    }
    private static Long nullableLong(ResultSet rows, String name) throws Exception { long value = rows.getLong(name); return rows.wasNull() ? null : value; }
    private Connection open() throws Exception {
        PrivateFiles.databaseExisting(database);
        Connection db = DriverManager.getConnection("jdbc:sqlite:" + database, PrivateFiles.sqliteExistingOptions());
        try (var sql = db.createStatement()) { sql.execute("PRAGMA busy_timeout=5000"); sql.execute("PRAGMA synchronous=FULL"); }
        catch (Exception error) { db.close(); throw error; }
        return db;
    }

    static final class Event {
        long id, startedAt = System.currentTimeMillis();
        String requestId = UUID.randomUUID().toString(), userId, login, action, source, tokenId, tokenName, connectionId, sqlOperation, sqlHash, sqlText, queryRequestId, exportFormat, outcome = "pending", code;
        Long finishedAt, durationMs, returnedRows, affectedRows;
        Integer httpStatus;
        private Event() { }
        Event(GitHubAuth.User actor, String action, String source) { this(actor == null ? null : actor.toActor(), action, source); }
        Event(Actor actor, String action, String source) { this.action = action; this.source = source; actor(actor); }
        void actor(Actor actor) { userId = actor == null ? null : actor.ownerKey(); login = actor == null ? null : actor.login(); }
        String toJson() {
            return "{\"sqlText\":" + JsonUtil.quote(sqlText) + ",\"id\":" + JsonUtil.quote(Long.toString(id)) + ",\"requestId\":" + JsonUtil.quote(requestId) + ",\"userId\":" + JsonUtil.quote(userId) + ",\"login\":" + JsonUtil.quote(login) + ",\"action\":" + JsonUtil.quote(action) + ",\"source\":" + JsonUtil.quote(source) + ",\"tokenId\":" + JsonUtil.quote(tokenId) + ",\"tokenName\":" + JsonUtil.quote(tokenName) + ",\"connectionId\":" + JsonUtil.quote(connectionId) + ",\"sqlOperation\":" + JsonUtil.quote(sqlOperation) + ",\"sqlHash\":" + JsonUtil.quote(sqlHash) + ",\"queryRequestId\":" + JsonUtil.quote(queryRequestId) + ",\"exportFormat\":" + JsonUtil.quote(exportFormat) + ",\"returnedRows\":" + returnedRows + ",\"affectedRows\":" + affectedRows + ",\"startedAt\":" + JsonUtil.quote(Instant.ofEpochMilli(startedAt).toString()) + ",\"finishedAt\":" + (finishedAt == null ? "null" : JsonUtil.quote(Instant.ofEpochMilli(finishedAt).toString())) + ",\"durationMs\":" + durationMs + ",\"httpStatus\":" + httpStatus + ",\"outcome\":" + JsonUtil.quote(outcome) + ",\"code\":" + JsonUtil.quote(code) + "}";
        }
    }
    record Page(List<Event> events, String nextCursor, boolean isAdmin) {
        String toJson() { return "{\"events\":[" + events.stream().map(Event::toJson).collect(java.util.stream.Collectors.joining(",")) + "],\"nextCursor\":" + JsonUtil.quote(nextCursor) + ",\"isAdmin\":" + isAdmin + "}"; }
    }
    static final class Unavailable extends RuntimeException { Unavailable() { super("Penyimpanan aktivitas tidak tersedia. Periksa izin privat volume data dan hindari tautan berkas."); } }
    static final class Forbidden extends RuntimeException { Forbidden() { super("Riwayat seluruh akun hanya dapat diakses admin audit."); } }
}
