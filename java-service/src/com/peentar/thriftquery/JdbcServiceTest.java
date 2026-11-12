package com.peentar.thriftquery;

import java.util.List;
import java.util.Arrays;
import java.util.Map;
import java.nio.file.Files;
import java.nio.file.Path;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Statement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

public final class JdbcServiceTest {
    public static void main(String[] args) throws Exception {
        if (!"SHOW NAMESPACES IN s3tables".equals(JdbcService.DATABASE_LIST_SQL)) {
            throw new AssertionError("Unexpected database list query: " + JdbcService.DATABASE_LIST_SQL);
        }

        JdbcService.QueryResult result = new JdbcService.QueryResult(
                List.of("id", "name"),
                Arrays.asList(Arrays.asList("1", "Ari"), Arrays.asList("2", null)),
                false,
                12,
                null
        );
        String expected = "{\"columns\":[\"id\",\"name\"],\"rows\":[{\"id\":\"1\",\"name\":\"Ari\"},{\"id\":\"2\",\"name\":null}],\"rowCount\":2,\"durationMs\":12,\"truncated\":false,\"updateCount\":null}";
        if (!expected.equals(result.toJson())) throw new AssertionError(result.toJson());
        checkExecution();
        checkLimitPolicy();
        System.out.println("Java JDBC result tests passed");
    }

    private static void checkExecution() throws Exception {
        Path root = Files.createTempDirectory("thrift-write-test");
        try {
            AppConfig config = AppConfig.load(root, Map.of(
                    "THRIFT_JDBC_URL", "jdbc:hive2://fixture.example/default",
                    "THRIFT_USERNAME", "fixture", "THRIFT_PASSWORD", "fixture"));
            AtomicInteger affectedRows = new AtomicInteger();
            AtomicBoolean writable = new AtomicBoolean();
            String[] executed = {null};
            Statement statement = proxy(Statement.class, (object, method, arguments) -> switch (method.getName()) {
                case "execute" -> { executed[0] = (String) arguments[0]; yield executed[0].startsWith("SELECT"); }
                case "getUpdateCount" -> affectedRows.get();
                case "getResultSet" -> resultSet(executed[0]);
                case "setQueryTimeout", "close" -> null;
                default -> throw new UnsupportedOperationException(method.getName());
            });
            Connection connection = proxy(Connection.class, (object, method, arguments) -> switch (method.getName()) {
                case "createStatement" -> statement;
                case "setReadOnly" -> {
                    if ((boolean) arguments[0]) throw new AssertionError("Connection must allow writes");
                    writable.set(true);
                    yield null;
                }
                case "close" -> null;
                default -> throw new UnsupportedOperationException(method.getName());
            });
            JdbcService service = new JdbcService(config, () -> connection);
            String[] writes = {"CREATE TABLE fixture (id INT)", "INSERT INTO fixture VALUES (1)",
                    "UPDATE fixture SET id = 2", "DELETE FROM fixture", "DROP TABLE fixture"};
            int[] counts = {-1, 25, 0, 2, -1};
            for (int index = 0; index < writes.length; index++) {
                affectedRows.set(counts[index]);
                JdbcService.QueryResult result = service.query(writes[index]);
                if (!writes[index].equals(executed[0])) throw new AssertionError("Write SQL must execute unchanged");
                if (!result.columns().isEmpty() || !result.rows().isEmpty()) throw new AssertionError("Write must not produce a fake result set");
                Long expectedCount = counts[index] < 0 ? null : (long) counts[index];
                if (!java.util.Objects.equals(expectedCount, result.updateCount())) throw new AssertionError("Unexpected update count");
                if (!result.toJson().contains("\"updateCount\":" + expectedCount)) throw new AssertionError(result.toJson());
            }
            JdbcService.QueryResult explicit = service.query("SELECT id FROM fixture LIMIT 20");
            if (explicit.rows().size() != 20 || explicit.truncated()) throw new AssertionError("LIMIT 20 must return 20 rows, not ten");
            JdbcService.QueryResult larger = service.query("SELECT id FROM `fixture` LIMIT 75");
            if (larger.rows().size() != 75 || larger.truncated()) throw new AssertionError("Explicit LIMIT must override the default 50");
            JdbcService.QueryResult rows = service.query("SELECT id FROM fixture");
            if (rows.rows().size() != 50 || !rows.truncated()) throw new AssertionError("Missing LIMIT must default to 50 rows");
            JdbcService.QueryResult nullLimit = service.query("SELECT id FROM `fixture` LIMIT NULL");
            if (nullLimit.rows().size() != 50 || !executed[0].endsWith("LIMIT 50")) throw new AssertionError("LIMIT NULL must use 50");
            JdbcService.QueryResult empty = service.query("SELECT id FROM fixture LIMIT 0");
            if (!empty.rows().isEmpty() || empty.truncated()) throw new AssertionError("LIMIT zero must remain zero");
            if (rows.updateCount() != null) throw new AssertionError("SELECT should not report affected rows");
            if (!writable.get()) throw new AssertionError("Connection must be configured for writes");
        } finally {
            Files.delete(root);
        }
    }

    private static void checkLimitPolicy() {
        for (String sql : List.of("SELECT 'LIMIT 20', `limit` FROM fixture", "SELECT * FROM (SELECT * FROM fixture LIMIT 20) t",
                "WITH t AS (SELECT * FROM fixture LIMIT 20) SELECT * FROM t", "SELECT limit FROM fixture",
                "WITH limit AS (SELECT * FROM fixture) SELECT * FROM limit", "SELECT * FROM fixture WHERE limit > 20",
                "SELECT * FROM fixture WHERE id > limit+1", "SELECT * FROM fixture ORDER BY id, limit+1 DESC")) {
            if (QueryLimits.plan(sql, 50).rowLimit() != 50) throw new AssertionError("Expected default limit: " + sql);
        }
        for (String sql : List.of("SELECT 1 LIMIT 20", "SELECT * FROM `fixture` LIMIT 75", "SELECT * FROM fixture ORDER BY `id` LIMIT 75", "SELECT * FROM fixture LIMIT 75 OFFSET 10",
                "SELECT * FROM fixture LIMIT 25+50", "SELECT * FROM fixture LIMIT (25+50)", "SELECT * FROM fixture LIMIT ALL")) {
            if (QueryLimits.plan(sql, 50).rowLimit() != Integer.MAX_VALUE) throw new AssertionError("Explicit limit must win: " + sql);
        }
        String withOffset = "SELECT NULL AS note FROM fixture LIMIT NULL OFFSET 10";
        if (!QueryLimits.plan(withOffset, 50).sql().equals("SELECT NULL AS note FROM fixture LIMIT 50 OFFSET 10")) {
            throw new AssertionError("Replace only the outer LIMIT NULL value");
        }
        String write = "WITH t AS (SELECT 1) INSERT INTO fixture SELECT * FROM t";
        if (!QueryLimits.plan(write, 50).sql().equals(write)) throw new AssertionError("Write SQL must stay unchanged");
    }

    private static ResultSet resultSet(String sql) {
        java.util.regex.Matcher limit = java.util.regex.Pattern.compile("(?i)LIMIT (\\d+)$").matcher(sql);
        int available = limit.find() ? Math.min(Integer.parseInt(limit.group(1)), 100) : 100;
        AtomicInteger row = new AtomicInteger();
        ResultSetMetaData metadata = proxy(ResultSetMetaData.class, (object, method, arguments) -> switch (method.getName()) {
            case "getColumnCount" -> 1;
            case "getColumnLabel" -> "id";
            default -> throw new UnsupportedOperationException(method.getName());
        });
        return proxy(ResultSet.class, (object, method, arguments) -> switch (method.getName()) {
            case "getMetaData" -> metadata;
            case "next" -> row.incrementAndGet() <= available;
            case "getString" -> String.valueOf(row.get());
            case "close" -> null;
            default -> throw new UnsupportedOperationException(method.getName());
        });
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }
}
