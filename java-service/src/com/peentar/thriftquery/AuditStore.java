package com.peentar.thriftquery;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
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

/** Safe operational metadata only. No request bodies, SQL text, credentials, or results. */
final class AuditStore {
    static final Set<String> ACTIONS = Set.of("auth.start", "auth.login", "auth.logout", "connection.list", "connection.save", "connection.test", "connection.connect", "connection.details", "connection.disconnect", "connection.delete", "query.execute", "metadata.databases", "metadata.namespaces", "metadata.tables", "metadata.columns", "result.export_requested");
    static final Set<String> OPERATIONS = Set.of("SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "CREATE", "INSERT", "UPDATE", "DELETE", "MERGE", "ALTER", "DROP", "TRUNCATE");
    private static final Set<String> OUTCOMES = Set.of("pending", "success", "failure", "denied");
    private static final Set<String> FILTERS = Set.of("scope", "userId", "from", "to", "action", "outcome", "connectionId", "cursor", "limit");
    private final Path database;

    AuditStore(Path dataDir) {
        database = dataDir.toAbsolutePath().normalize().resolve("audit.sqlite");
        synchronized (AuditStore.class) {
            try {
                Class.forName("org.sqlite.JDBC");
                Files.createDirectories(database.getParent());
                restrict(database.getParent(), "rwx------");
                if (!Files.exists(database)) {
                    if (database.getFileSystem().supportedFileAttributeViews().contains("posix")) Files.createFile(database, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
                    else Files.createFile(database);
                }
                restrict(database, "rw-------");
                try (var db = open(); var sql = db.createStatement()) {
                    try (var version = sql.executeQuery("PRAGMA user_version")) { if (version.next() && (version.getInt(1) < 0 || version.getInt(1) > 1)) throw new Unavailable(); }
                    sql.execute("PRAGMA journal_mode=WAL");
                    sql.executeUpdate("CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL, user_id TEXT, login TEXT, action TEXT NOT NULL, source TEXT NOT NULL, connection_id TEXT, sql_operation TEXT, sql_hash TEXT, query_request_id TEXT, export_format TEXT, returned_rows INTEGER, affected_rows INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, duration_ms INTEGER, http_status INTEGER, outcome TEXT NOT NULL, code TEXT)");
                    sql.executeUpdate("CREATE INDEX IF NOT EXISTS audit_owner_order ON audit_events(user_id,id DESC)");
                    sql.executeUpdate("CREATE INDEX IF NOT EXISTS audit_started ON audit_events(started_at)");
                    sql.executeUpdate("CREATE INDEX IF NOT EXISTS audit_action_order ON audit_events(action,id DESC)");
                    sql.executeUpdate("PRAGMA user_version=1");
                }
            } catch (Exception error) { throw new Unavailable(); }
        }
    }

    synchronized void begin(Event event) {
        validate(event);
        if (!event.outcome.equals("pending") || event.finishedAt != null) throw new IllegalArgumentException("Invalid pending audit");
        try (var db = open(); var sql = db.prepareStatement("INSERT INTO audit_events(request_id,user_id,login,action,source,connection_id,sql_operation,sql_hash,query_request_id,export_format,returned_rows,affected_rows,started_at,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")) {
            sql.setString(1, event.requestId); sql.setString(2, event.userId); sql.setString(3, event.login); sql.setString(4, event.action); sql.setString(5, event.source);
            bindMetadata(sql, 6, event); sql.setLong(13, event.startedAt); sql.setString(14, "pending");
            sql.executeUpdate();
        } catch (Exception error) { throw new Unavailable(); }
    }

    synchronized void annotate(Event event) {
        validate(event);
        try (var db = open(); var sql = db.prepareStatement("UPDATE audit_events SET connection_id=?,sql_operation=?,sql_hash=?,query_request_id=?,export_format=?,returned_rows=?,affected_rows=? WHERE request_id=? AND outcome='pending'")) {
            bindMetadata(sql, 1, event); sql.setString(8, event.requestId);
            if (sql.executeUpdate() != 1) throw new Unavailable();
        } catch (Exception error) { throw new Unavailable(); }
    }

    synchronized void finish(Event event) {
        validate(event);
        if (event.finishedAt == null || event.outcome.equals("pending") || event.durationMs == null || event.durationMs < 0 || event.httpStatus == null || event.httpStatus < 100 || event.httpStatus > 599) throw new IllegalArgumentException("Invalid finished audit");
        try (var db = open(); var sql = db.prepareStatement("UPDATE audit_events SET connection_id=?,sql_operation=?,sql_hash=?,query_request_id=?,export_format=?,returned_rows=?,affected_rows=?,user_id=?,login=?,finished_at=?,duration_ms=?,http_status=?,outcome=?,code=? WHERE request_id=? AND outcome='pending'")) {
            bindMetadata(sql, 1, event); sql.setString(8, event.userId); sql.setString(9, event.login); sql.setLong(10, event.finishedAt); sql.setLong(11, event.durationMs); sql.setInt(12, event.httpStatus); sql.setString(13, event.outcome); sql.setString(14, event.code); sql.setString(15, event.requestId);
            if (sql.executeUpdate() != 1) throw new Unavailable();
        } catch (Exception error) { throw new Unavailable(); }
    }

    Page list(String ownerId, boolean admin, Map<String, String> filters) {
        GitHubAuth.validId(ownerId);
        if (!FILTERS.containsAll(filters.keySet())) throw new IllegalArgumentException("Filter aktivitas tidak dikenal.");
        String scope = filters.getOrDefault("scope", "mine");
        if (!scope.equals("mine") && !scope.equals("all")) throw new IllegalArgumentException("Scope aktivitas tidak valid.");
        if ((scope.equals("all") || filters.containsKey("userId")) && !admin) throw new Forbidden();
        if (filters.containsKey("userId") && !scope.equals("all")) throw new IllegalArgumentException("Filter akun memerlukan scope seluruh pengguna.");
        String actor = scope.equals("mine") ? ownerId : filters.get("userId");
        if (actor != null) GitHubAuth.validId(actor);
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
        GitHubAuth.validId(ownerId);
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
        if (event.userId != null) new GitHubAuth.User(event.userId, event.login);
        else if (event.login != null) throw new IllegalArgumentException("Unverified actor");
        if (!(event.action.equals("result.export_requested") ? event.source.equals("browser") : event.source.equals("server"))) throw new IllegalArgumentException("Invalid event source");
        if (event.connectionId != null && !event.connectionId.matches("[a-zA-Z0-9_-]{1,100}")) throw new IllegalArgumentException("Invalid connection reference");
        if (event.sqlOperation != null && !OPERATIONS.contains(event.sqlOperation) || event.sqlHash != null && !event.sqlHash.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid SQL metadata");
        if (event.queryRequestId != null && !event.queryRequestId.matches("[0-9a-f-]{36}") || event.exportFormat != null && !Set.of("csv", "json").contains(event.exportFormat)) throw new IllegalArgumentException("Invalid export metadata");
        if (event.returnedRows != null && event.returnedRows < 0 || event.affectedRows != null && event.affectedRows < 0) throw new IllegalArgumentException("Invalid row count");
        if (event.code != null && !(event.code.equals("OK") || event.code.matches("HTTP_[345][0-9]{2}") || Set.of("AUTH_INVALID_STATE", "AUTH_FAILED", "AUTH_DENIED", "AUTH_NOT_ALLOWED", "AUTH_BUSY", "AUTH_NOT_CONFIGURED").contains(event.code))) throw new IllegalArgumentException("Invalid safe outcome code");
    }
    private static void bindMetadata(PreparedStatement sql, int index, Event event) throws Exception {
        sql.setString(index++, event.connectionId); sql.setString(index++, event.sqlOperation); sql.setString(index++, event.sqlHash); sql.setString(index++, event.queryRequestId); sql.setString(index++, event.exportFormat); sql.setObject(index++, event.returnedRows); sql.setObject(index, event.affectedRows);
    }
    private static Event read(ResultSet rows) throws Exception {
        Event e = new Event(); e.id = rows.getLong("id"); e.requestId = rows.getString("request_id"); e.userId = rows.getString("user_id"); e.login = rows.getString("login"); e.action = rows.getString("action"); e.source = rows.getString("source"); e.connectionId = rows.getString("connection_id"); e.sqlOperation = rows.getString("sql_operation"); e.sqlHash = rows.getString("sql_hash"); e.queryRequestId = rows.getString("query_request_id"); e.exportFormat = rows.getString("export_format"); e.returnedRows = nullableLong(rows,"returned_rows"); e.affectedRows = nullableLong(rows,"affected_rows"); e.startedAt = rows.getLong("started_at"); e.finishedAt = nullableLong(rows,"finished_at"); e.durationMs = nullableLong(rows,"duration_ms"); var status = nullableLong(rows,"http_status"); e.httpStatus = status == null ? null : status.intValue(); e.outcome = rows.getString("outcome"); e.code = rows.getString("code"); return e;
    }
    private static Long nullableLong(ResultSet rows, String name) throws Exception { long value = rows.getLong(name); return rows.wasNull() ? null : value; }
    private Connection open() throws Exception {
        Connection db = DriverManager.getConnection("jdbc:sqlite:" + database);
        try (var sql = db.createStatement()) { sql.execute("PRAGMA busy_timeout=5000"); sql.execute("PRAGMA synchronous=FULL"); }
        catch (Exception error) { db.close(); throw error; }
        return db;
    }
    private static void restrict(Path path, String mode) throws Exception { if (path.getFileSystem().supportedFileAttributeViews().contains("posix")) Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(mode)); }

    static final class Event {
        long id, startedAt = System.currentTimeMillis();
        String requestId = UUID.randomUUID().toString(), userId, login, action, source, connectionId, sqlOperation, sqlHash, queryRequestId, exportFormat, outcome = "pending", code;
        Long finishedAt, durationMs, returnedRows, affectedRows;
        Integer httpStatus;
        private Event() { }
        Event(GitHubAuth.User actor, String action, String source) { this.action = action; this.source = source; actor(actor); }
        void actor(GitHubAuth.User actor) { userId = actor == null ? null : actor.id(); login = actor == null ? null : actor.login(); }
        String toJson() {
            return "{\"id\":" + JsonUtil.quote(Long.toString(id)) + ",\"requestId\":" + JsonUtil.quote(requestId) + ",\"userId\":" + JsonUtil.quote(userId) + ",\"login\":" + JsonUtil.quote(login) + ",\"action\":" + JsonUtil.quote(action) + ",\"source\":" + JsonUtil.quote(source) + ",\"connectionId\":" + JsonUtil.quote(connectionId) + ",\"sqlOperation\":" + JsonUtil.quote(sqlOperation) + ",\"sqlHash\":" + JsonUtil.quote(sqlHash) + ",\"queryRequestId\":" + JsonUtil.quote(queryRequestId) + ",\"exportFormat\":" + JsonUtil.quote(exportFormat) + ",\"returnedRows\":" + returnedRows + ",\"affectedRows\":" + affectedRows + ",\"startedAt\":" + JsonUtil.quote(Instant.ofEpochMilli(startedAt).toString()) + ",\"finishedAt\":" + (finishedAt == null ? "null" : JsonUtil.quote(Instant.ofEpochMilli(finishedAt).toString())) + ",\"durationMs\":" + durationMs + ",\"httpStatus\":" + httpStatus + ",\"outcome\":" + JsonUtil.quote(outcome) + ",\"code\":" + JsonUtil.quote(code) + "}";
        }
    }
    record Page(List<Event> events, String nextCursor, boolean isAdmin) {
        String toJson() { return "{\"events\":[" + events.stream().map(Event::toJson).collect(java.util.stream.Collectors.joining(",")) + "],\"nextCursor\":" + JsonUtil.quote(nextCursor) + ",\"isAdmin\":" + isAdmin + "}"; }
    }
    static final class Unavailable extends RuntimeException { Unavailable() { super("Penyimpanan aktivitas tidak tersedia. Periksa volume data."); } }
    static final class Forbidden extends RuntimeException { Forbidden() { super("Riwayat seluruh akun hanya dapat diakses admin audit."); } }
}
