package com.peentar.thriftquery;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Real HTTP routes with synthetic JDBC connections: no external database or credentials. */
public final class ConnectionHttpTest {
    private static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private static String sessionCookie;

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-http");
        AppConfig config = AppConfig.load(root, Map.of("GITHUB_CLIENT_ID", "fixture-id", "GITHUB_CLIENT_SECRET", "fixture-secret"));
        List<String> executed = new ArrayList<>();
        ConnectionRegistry.ServiceFactory factory = profile -> new JdbcService(config, profile, () -> fixture(profile, executed));
        ConnectionWorkspaces workspaces = new ConnectionWorkspaces(config, factory);
        ConnectionRegistry registry = workspaces.forOwner("1001");
        ThriftQueryServer server = new ThriftQueryServer(config, workspaces, new GitHubAuth(config.auth, (code, verifier) -> new GitHubAuth.User("1001", "fixture-user")));
        try {
            server.start(0);
            String base = "http://127.0.0.1:" + server.port();
            sessionCookie = GitHubAuthTest.login(base);
            check(get(base, "/api/connections", 200).contains("\"connections\":[]"), "Initially empty");
            post(base, "/api/connections", profile("postgresql", "Route-named", "test"), 200);
            check(get(base, "/api/connections/test", 200).contains("fixture-secret"), "Valid IDs matching route names can be edited");
            delete(base, "/api/connections/test", 200);
            String pg = JsonUtil.stringField(post(base, "/api/connections/connect", profile("postgresql", "Same name", ""), 200), "id");
            String my = JsonUtil.stringField(post(base, "/api/connections/connect", profile("mysql", "Same name", ""), 200), "id");
            check(!pg.equals(my), "Unique IDs despite duplicate names");
            String list = get(base, "/api/connections", 200);
            check(list.contains(pg) && list.contains(my), list);
            check(!list.contains("fixture-secret") && !list.contains("password"), "Credentials never returned");
            String details = get(base, "/api/connections/" + pg, 200);
            check(JsonUtil.stringField(details, "password").equals("fixture-secret"), "Explicit edit loads saved password");
            check(JsonUtil.stringField(details, "jdbcUrl").equals("jdbc:postgresql://fixture:5432/app?sslmode=disable"), "Explicit edit loads canonical JDBC URL");
            for (String id : List.of(pg, my)) {
                String type = id.equals(pg) ? "postgresql" : "mysql";
                check(get(base, "/api/databases?connectionId=" + id, 200).contains(type + "_schema"), "Schema routing");
                check(get(base, "/api/tables?namespace=app&connectionId=" + id, 200).contains(type + "_table"), "Table routing");
                check(get(base, "/api/columns?namespace=app&table=fixture&connectionId=" + id, 200).contains(type + "_column"), "Column routing");
                String rows = post(base, "/api/query", "{\"connectionId\":\"" + id + "\",\"sql\":\"SELECT id FROM fixture LIMIT 20;\"}", 200);
                check(rows.contains("\"rowCount\":20") && rows.contains(type + ":Same name"), rows);
                String write = post(base, "/api/query", "{\"connectionId\":\"" + id + "\",\"sql\":\"UPDATE fixture SET id=2\"}", 200);
                check(write.contains("\"updateCount\":1"), write);
            }
            for (String sql : List.of("SELECT id FROM fixture", "SELECT id FROM fixture LIMIT NULL;")) {
                check(post(base, "/api/query", "{\"connectionId\":\"" + pg + "\",\"sql\":\"" + sql + "\"}", 200).contains("\"rowCount\":50"), "Fallback limit 50");
            }
            post(base, "/api/connections/connect", profile("postgresql", "broken", pg), 502);
            check(JsonUtil.stringField(get(base, "/api/connections/" + pg, 200), "name").equals("Same name"), "Failed reconnect preserves saved configuration");
            check(post(base, "/api/query", "{\"connectionId\":\"" + pg + "\",\"sql\":\"SELECT 1 LIMIT 1\"}", 200).contains("postgresql:Same name"), "Failed reconnect retains original");
            post(base, "/api/connections/connect", profile("mysql", "Reconnected", my), 200);
            check(post(base, "/api/query", "{\"connectionId\":\"" + my + "\",\"sql\":\"SELECT 1 LIMIT 1\"}", 200).contains("mysql:Reconnected"), "Reconnect retains ID");
            post(base, "/api/connections/disconnect", "{\"connectionId\":\"" + my + "\"}", 200);
            check(get(base, "/api/connections/" + my, 200).contains("fixture-secret"), "Disconnect retains credentials for edit");
            for (String id : List.of(my, "unknown")) {
                post(base, "/api/query", "{\"connectionId\":\"" + id + "\",\"sql\":\"DELETE FROM fixture\"}", 404);
                get(base, "/api/databases?connectionId=" + id, 404);
                get(base, "/api/tables?namespace=app&connectionId=" + id, 404);
                get(base, "/api/columns?namespace=app&table=fixture&connectionId=" + id, 404);
                post(base, "/api/connections/disconnect", "{\"connectionId\":\"" + id + "\"}", 404);
            }
            check(post(base, "/api/query", "{\"sql\":\"SELECT 1 LIMIT 1\"}", 200).contains("postgresql:Same name"), "Legacy default remains first connection");
            check(get(base, "/api/health", 200).contains("\"configured\":true"), "Health available");
            Path database = config.dataDir.resolve("gridbase.sqlite"), blocked = config.dataDir.resolve("blocked.sqlite");
            Files.move(database, blocked); Files.createDirectory(database);
            try {
                post(base, "/api/connections", profile("postgresql", "Cannot save", pg), 503);
                post(base, "/api/connections/connect", profile("postgresql", "Cannot connect", pg), 503);
                delete(base, "/api/connections/" + pg, 503);
                check(JsonUtil.stringField(get(base, "/api/connections/" + pg, 200), "name").equals("Same name"), "Storage failure preserves runtime settings");
                check(post(base, "/api/query", "{\"connectionId\":\"" + pg + "\",\"sql\":\"SELECT 1 LIMIT 1\"}", 200).contains("postgresql:Same name"), "Storage failure preserves active service");
            } finally { Files.delete(database); Files.move(blocked, database); }
            check(executed.stream().noneMatch(value -> value.contains("DELETE")), "Unknown-ID writes must never execute");
            post(base, "/api/connections/connect", profile("mysql", "Remaining", my), 200);
            post(base, "/api/connections/disconnect", "{\"connectionId\":\"" + pg + "\"}", 200);
            post(base, "/api/query", "{\"sql\":\"DELETE FROM fixture\"}", 503);
            check(get(base, "/api/health", 200).contains("\"configured\":true"), "Remaining explicit connection is configured");
            check(post(base, "/api/query", "{\"connectionId\":\"" + my + "\",\"sql\":\"SELECT 1 LIMIT 1\"}", 200).contains("mysql:Remaining"), "Explicit remaining source still works");
            String saved = JsonUtil.stringField(post(base, "/api/connections", profile("postgresql", "broken", ""), 200), "id");
            check(get(base, "/api/connections/" + saved, 200).contains("fixture-secret"), "Offline save does not test the remote database");
            post(base, "/api/connections", profile("postgresql", "Updated offline", saved).replace("fixture-secret", "updated-secret"), 200);
            server.stop();
            workspaces = new ConnectionWorkspaces(config, factory);
            registry = workspaces.forOwner("1001");
            server = new ThriftQueryServer(config, workspaces, new GitHubAuth(config.auth, (code, verifier) -> new GitHubAuth.User("1001", "fixture-user"))); server.start(0);
            base = "http://127.0.0.1:" + server.port();
            sessionCookie = GitHubAuthTest.login(base);
            check(get(base, "/api/connections", 200).contains("\"defaultConnectionId\":null"), "Restart has no implicit default");
            check(registry.entries().stream().noneMatch(ConnectionRegistry.Entry::connected), "Restart restores only disconnected profiles");
            check(get(base, "/api/health", 200).contains("\"configured\":false"), "Saved profiles are not active connections");
            check(get(base, "/api/connections/" + saved, 200).contains("updated-secret"), "Updated password survives restart");
            post(base, "/api/query", "{\"connectionId\":\"" + saved + "\",\"sql\":\"DELETE FROM fixture\"}", 404);
            delete(base, "/api/connections/" + saved, 200);
            get(base, "/api/connections/" + saved, 404);
            check(!new ConnectionStore(config.dataDir, "1001").load().containsKey(saved), "Deletion persists in SQLite");
            System.out.println("Multi-connection HTTP tests passed (synthetic JDBC)");
        } finally {
            server.stop();
            try (var paths = Files.walk(root)) { for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); }
        }
    }

    static Connection fixture(ConnectionProfile profile, List<String> executed) throws SQLException {
        if (profile.name().equals("broken")) throw new SQLException("fixture failure");
        String type = profile.type().id();
        DatabaseMetaData metadata = proxy(DatabaseMetaData.class, (p,m,a) -> switch (m.getName()) {
            case "getSchemas" -> rows(List.of("TABLE_SCHEM"), List.of(List.of(type + "_schema")));
            case "getCatalogs" -> rows(List.of("TABLE_CAT"), List.of(List.of(type + "_schema")));
            case "getTables" -> rows(List.of("TABLE_NAME"), List.of(List.of(type + "_table")));
            case "getColumns" -> rows(List.of("COLUMN_NAME", "TYPE_NAME", "REMARKS"), List.of(List.of(type + "_column", "INTEGER", "fixture")));
            default -> throw new UnsupportedOperationException(m.getName());
        });
        String[] sql = {""};
        Statement statement = proxy(Statement.class, (p,m,a) -> switch (m.getName()) {
            case "execute" -> { sql[0] = (String) a[0]; executed.add(type + ":" + sql[0]); yield sql[0].startsWith("SELECT"); }
            case "getResultSet" -> {
                var limit = java.util.regex.Pattern.compile("(?i)LIMIT (\\d+)").matcher(sql[0]);
                int count = limit.find() ? Integer.parseInt(limit.group(1)) : 100;
                List<List<String>> values = new ArrayList<>();
                for (int i=0;i<count;i++) values.add(List.of(type + ":" + profile.name()));
                yield rows(List.of("origin"), values);
            }
            case "getUpdateCount" -> 1;
            case "setQueryTimeout", "close" -> null;
            default -> throw new UnsupportedOperationException(m.getName());
        });
        return proxy(Connection.class, (p,m,a) -> switch (m.getName()) {
            case "isValid" -> true;
            case "getMetaData" -> metadata;
            case "getCatalog" -> "fixture";
            case "createStatement" -> statement;
            case "setReadOnly", "close" -> null;
            default -> throw new UnsupportedOperationException(m.getName());
        });
    }
    private static ResultSet rows(List<String> columns, List<List<String>> values) {
        int[] cursor = {-1};
        ResultSetMetaData metadata = proxy(ResultSetMetaData.class, (p,m,a) -> switch (m.getName()) {
            case "getColumnCount" -> columns.size();
            case "getColumnLabel" -> columns.get((int) a[0] - 1);
            default -> throw new UnsupportedOperationException(m.getName());
        });
        return proxy(ResultSet.class, (p,m,a) -> switch (m.getName()) {
            case "next" -> ++cursor[0] < values.size();
            case "getString" -> values.get(cursor[0]).get(a[0] instanceof Integer ? (int) a[0] - 1 : columns.indexOf(a[0]));
            case "getMetaData" -> metadata;
            case "close" -> null;
            default -> throw new UnsupportedOperationException(m.getName());
        });
    }
    private static String profile(String type, String name, String id) {
        return "{\"type\":\"" + type + "\",\"name\":\"" + name + "\",\"host\":\"fixture\",\"database\":\"app\",\"username\":\"fixture\",\"password\":\"fixture-secret\"" + (id.isEmpty() ? "" : ",\"connectionId\":\"" + id + "\"") + "}";
    }
    private static String get(String base, String path, int status) throws Exception {
        return request(HttpRequest.newBuilder(URI.create(base + path)).GET().build(), status);
    }
    private static String post(String base, String path, String body, int status) throws Exception {
        return request(HttpRequest.newBuilder(URI.create(base + path)).header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build(), status);
    }
    private static String delete(String base, String path, int status) throws Exception {
        return request(HttpRequest.newBuilder(URI.create(base + path)).DELETE().build(), status);
    }
    private static String request(HttpRequest request, int status) throws Exception {
        HttpResponse<String> response = CLIENT.send(HttpRequest.newBuilder(request, (name, value) -> true).header("Cookie", sessionCookie).build(), HttpResponse.BodyHandlers.ofString());
        check(response.statusCode() == status, request.uri().getPath() + " expected " + status + ", got " + response.statusCode() + ": " + response.body());
        check(response.headers().firstValue("Cache-Control").orElse("").equals("no-store"), "API responses must not be cached");
        return response.body();
    }
    private static <T> T proxy(Class<T> type, InvocationHandler handler) { return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class[]{type}, handler)); }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
