package com.peentar.thriftquery;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Proxy JDBC fixtures deliberately have no network/database access. */
public final class McpJdbcTest {
    private static int checks;

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-mcp-jdbc-");
        try {
            AppConfig config = AppConfig.load(root, Map.of("DEFAULT_QUERY_LIMIT", "10", "QUERY_TIMEOUT_SECONDS", "30"));
            Fixture fixture = new Fixture(DatabaseType.POSTGRESQL);
            JdbcService base = fixture.service(config);
            JdbcService view = base.forMcp(policy(true, 500, 1000));
            JdbcService.QueryResult result = view.query("SELECT id FROM fixture LIMIT 99999");
            check(result.rows().size() == 500 && result.truncated(), "Independent 500-row cap even with SQL LIMIT");
            check(fixture.events.indexOf("readOnly:true") < fixture.events.indexOf("autoCommit:false"), "Read-only requested before transaction");
            check(fixture.events.indexOf("execute:SET TRANSACTION READ ONLY") < fixture.events.indexOf("execute:SELECT id FROM fixture LIMIT 99999"), "Enforced transaction before user SQL");
            check(fixture.events.contains("rollback") && fixture.events.get(fixture.events.size()-1).equals("connection.close"), "Rollback and close");
            check(fixture.maxRows == 501, "Driver cap includes one sentinel row");
            check(fixture.timeout > 0 && fixture.timeout <= 3, "Remaining deadline controls timeout");
            for (DatabaseType type : DatabaseType.values()) {
                Fixture metadata = new Fixture(type);
                JdbcService service = metadata.service(config).forMcp(policy(true, 500, 1000));
                check(service.databases().size() == 1000, type + " database cap");
                check(service.tables("fixture").size() == 1000, type + " table cap");
                check(service.columns("fixture", "fixture").size() == 1000, type + " column cap");
                if (type.isHive()) {
                    check(metadata.events.stream().noneMatch(e -> e.startsWith("readOnly:") || e.startsWith("autoCommit:") || e.equals("rollback")), "Hive never uses unsupported connection flags");
                    check(metadata.events.contains("execute:SHOW NAMESPACES IN s3tables"), "Hive s3tables preserved");
                    check(metadata.events.contains("execute:SHOW TABLES IN `s3tables`.`fixture`"), "Hive table catalog preserved");
                } else {
                    check(metadata.events.stream().filter(e -> e.equals("rollback")).count() == 3, "All metadata paths rolled back");
                    check(metadata.events.indexOf("execute:SET TRANSACTION READ ONLY") < metadata.events.indexOf("getMetaData"), "Metadata setup before metadata calls");
                }
                check(metadata.events.stream().filter(e -> e.equals("connection.close")).count() == 3, "All metadata paths closed");
                check(metadata.rowsRead <= 3003, "Metadata consumption bounded, not just retained entries");
            }
            for (DatabaseType type : DatabaseType.values()) {
                Fixture duplicateMetadata = new Fixture(type);
                duplicateMetadata.cell = "duplicate";
                JdbcService duplicateService = duplicateMetadata.service(config).forMcp(policy(true,500,1000));
                check(duplicateService.databases().size() == 1 && duplicateService.metadataTruncated(), "Duplicate metadata still reports omitted rows");
                duplicateMetadata.available = 1;
                check(duplicateService.databases().size() == 1 && !duplicateService.metadataTruncated(), "Metadata truncation resets per operation");
                Fixture byteMetadata = new Fixture(type);
                byteMetadata.cell = "x".repeat(70_000);
                JdbcService byteService = byteMetadata.service(config).forMcp(policy(true,500,1000));
                check(byteService.databases().isEmpty() && byteService.metadataTruncated(), "Metadata byte cap reports truncation");
            }
            for (String fail : List.of("readOnly:true", "autoCommit:false", "execute:SET TRANSACTION READ ONLY")) {
                Fixture bad = new Fixture(DatabaseType.POSTGRESQL);
                bad.fail = fail;
                failsSql(() -> bad.service(config).forMcp(policy(true, 500, 1000)).query("SELECT 1"));
                check(bad.events.stream().noneMatch(e -> e.equals("execute:SELECT 1")), "Fail closed: " + fail);
                check(bad.events.contains("rollback") && bad.events.contains("connection.close"), "Setup failure cleanup: " + fail);
            }
            Fixture failedQuery = new Fixture(DatabaseType.MYSQL);
            failedQuery.fail = "execute:SELECT 1";
            failsSql(() -> failedQuery.service(config).forMcp(policy(true, 500, 1000)).query("SELECT 1"));
            check(failedQuery.events.contains("rollback") && failedQuery.events.contains("connection.close"), "Query failure cleanup");
            Fixture expired = new Fixture(DatabaseType.HIVE);
            JdbcService expiredService = expired.service(config).forMcp(new McpExecutionPolicy("g", true, 500, 1000, System.nanoTime()-1));
            failsSql(expiredService::databases);
            failsSql(() -> expiredService.query("SELECT 1"));
            check(expired.opens == 0, "Expired requests do not open JDBC");
            Fixture oversized = new Fixture(DatabaseType.POSTGRESQL);
            oversized.cell = "x".repeat(70_000);
            JdbcService.QueryResult large = oversized.service(config).forMcp(policy(true, 500, 1000)).query("SELECT id FROM fixture");
            check(large.rows().isEmpty() && large.truncated(), "Oversized cell is not retained");
            Fixture hugeLabels = new Fixture(DatabaseType.POSTGRESQL);
            hugeLabels.label = "x".repeat(200_000);
            JdbcService.QueryResult labelResult = hugeLabels.service(config).forMcp(policy(true,500,1000)).query("SELECT 1");
            check(labelResult.truncated() && labelResult.rows().isEmpty() && labelResult.toJson().length() < 1_048_576, "Column-label byte cap reports truncation");
            Fixture payload = new Fixture(DatabaseType.POSTGRESQL);
            payload.cell = "\\\"".repeat(10_000);
            JdbcService.QueryResult bounded = payload.service(config).forMcp(policy(true, 500, 1000)).query("SELECT id FROM fixture LIMIT 99999");
            check(bounded.rows().size() < 500 && bounded.truncated() && bounded.toJson().getBytes(java.nio.charset.StandardCharsets.UTF_8).length < 1_048_576, "Serialized-size budget");
            Fixture writable = new Fixture(DatabaseType.MYSQL);
            writable.hasResult = false;
            JdbcService.QueryResult written = writable.service(config).forMcp(policy(false, 500, 1000)).query("UPDATE fixture SET id=2");
            check(written.updateCount() == 7, "Full-access writes preserved");
            check(writable.events.stream().noneMatch(e -> e.equals("readOnly:true") || e.equals("rollback")), "Full access not downgraded unexpectedly");
            Fixture denied = new Fixture(DatabaseType.HIVE);
            try { denied.service(config).forMcp(policy(true, 500, 1000)).query("DELETE FROM fixture"); throw new AssertionError("Expected SQL rejection"); }
            catch (IllegalArgumentException expected) { check(denied.opens == 0, "Policy rejects before JDBC"); }
            for (int[] invalid : List.of(new int[]{0,1}, new int[]{501,1}, new int[]{1,0}, new int[]{1,1001})) {
                try { policy(true, invalid[0], invalid[1]); throw new AssertionError("Expected invalid policy limits"); }
                catch (IllegalArgumentException expected) { checks++; }
            }
            try { new McpExecutionPolicy(" ", true, 500, 1000, System.nanoTime()); throw new AssertionError("Expected generation validation"); }
            catch (IllegalArgumentException expected) { checks++; }
            try { view.forMcp(policy(false, 500, 1000)); throw new AssertionError("Expected immutable policy view"); }
            catch (IllegalStateException expected) { checks++; }
            Fixture late = new Fixture(DatabaseType.POSTGRESQL);
            long deadline = System.nanoTime() + 40_000_000L;
            JdbcService lateService = new JdbcService(config, base.profile(), () -> {
                while (System.nanoTime() < deadline) Thread.onSpinWait();
                return late.connection();
            }).forMcp(new McpExecutionPolicy("g", true, 500, 1000, deadline));
            failsSql(lateService::databases);
            check(late.events.contains("connection.close") && !late.events.contains("getMetaData"), "Late connection closed before metadata");
            Fixture timedRows = new Fixture(DatabaseType.POSTGRESQL);
            timedRows.interruptRows = true;
            try {
                failsSql(() -> timedRows.service(config).forMcp(policy(true,500,1000)).query("SELECT 1"));
                check(timedRows.events.contains("result.close") && timedRows.events.contains("statement.close")
                        && timedRows.events.contains("rollback") && timedRows.events.contains("connection.close"), "Interrupted result cleanup");
            } finally { Thread.interrupted(); }
            Fixture nullRows = new Fixture(DatabaseType.POSTGRESQL);
            nullRows.nullCells = true;
            JdbcService.QueryResult nullResult = nullRows.service(config).forMcp(policy(true,500,1000)).query("SELECT 1");
            check(nullResult.rows().get(0).get(0) == null && nullResult.toJson().contains("\"id\":null"), "Null SQL cells preserved");
            Fixture failedMetadata = new Fixture(DatabaseType.MYSQL);
            failedMetadata.fail = "getTables";
            failsSql(() -> failedMetadata.service(config).forMcp(policy(true,500,1000)).tables("fixture"));
            check(failedMetadata.events.contains("rollback") && failedMetadata.events.contains("connection.close"), "Metadata failure cleanup");
            Fixture failedRollback = new Fixture(DatabaseType.MYSQL);
            failedRollback.fail = "rollback";
            failsSql(() -> failedRollback.service(config).forMcp(policy(true,500,1000)).query("SELECT 1"));
            check(failedRollback.events.contains("connection.close"), "Close despite rollback failure");
            for (DatabaseType type : List.of(DatabaseType.POSTGRESQL, DatabaseType.MYSQL)) {
                java.util.Properties options = JdbcService.mcpDriverProperties(type, 3);
                check(options.getProperty("connectTimeout").equals(type == DatabaseType.MYSQL ? "3000" : "3"), "Per-open connect timeout units");
                check(options.getProperty("socketTimeout").equals(type == DatabaseType.MYSQL ? "3000" : "3"), "Per-open socket timeout units");
                String url = (type == DatabaseType.MYSQL ? "jdbc:mysql:" : "jdbc:postgresql:") + "//fixture.invalid/db?socketTimeout=0&connectTimeout=0&readOnlyMode=ignore&sslmode=require";
                String boundedUrl = JdbcService.mcpJdbcUrl(url, options);
                check(!boundedUrl.contains("Timeout=0") && (type != DatabaseType.POSTGRESQL || !boundedUrl.contains("readOnlyMode=ignore")) && boundedUrl.contains("sslmode=require"), "URL cannot override bounded properties");
            }
            Fixture probe = new Fixture(DatabaseType.POSTGRESQL);
            probe.service(config).forMcp(policy(true,500,1000)).testConnection();
            check(probe.events.contains("readOnly:true") && probe.events.contains("rollback") && probe.events.contains("connection.close"), "MCP connection test also uses policy");
            Fixture ordinary = new Fixture(DatabaseType.MYSQL);
            JdbcService unchanged = ordinary.service(config);
            unchanged.forMcp(policy(true, 2, 2));
            check(unchanged.query("SELECT id FROM fixture").rows().size() == 10, "Ordinary default unchanged");
            check(ordinary.events.contains("readOnly:false") && !ordinary.events.contains("rollback"), "Ordinary write semantics unchanged");
        } finally { Files.delete(root); }
        System.out.println("Java MCP bounded JDBC tests passed (checks=" + checks + ")");
    }

    private static McpExecutionPolicy policy(boolean readOnly, int rows, int metadata) {
        return new McpExecutionPolicy("generation-fixture", readOnly, rows, metadata, System.nanoTime() + 2_500_000_000L);
    }

    @FunctionalInterface private interface SqlCall { Object run() throws Exception; }
    private static void failsSql(SqlCall call) throws Exception {
        try { call.run(); throw new AssertionError("Expected SQLException"); }
        catch (SQLException expected) { checks++; }
    }

    private static void check(boolean condition, String message) {
        checks++;
        if (!condition) throw new AssertionError(message);
    }

    private static final class Fixture {
        final DatabaseType type;
        final List<String> events = new ArrayList<>();
        int available = 1600;
        int maxRows;
        int timeout;
        int opens;
        int columnCount = 1;
        int rowsRead;
        String cell;
        String label;
        String fail;
        boolean hasResult = true;
        boolean interruptRows;
        boolean nullCells;

        Fixture(DatabaseType type) { this.type = type; }

        JdbcService service(AppConfig config) {
            String url = switch (type) {
                case POSTGRESQL -> "jdbc:postgresql://fixture.invalid/database";
                case MYSQL -> "jdbc:mysql://fixture.invalid/database";
                case HIVE -> "jdbc:hive2://fixture.invalid/database";
            };
            return new JdbcService(config, new ConnectionProfile(type, "Fixture", url, "fixture", "fixture"), () -> { opens++; return connection(); });
        }

        private Connection connection() {
            return proxy(Connection.class, (o,m,a) -> {
                String name = m.getName();
                return switch (name) {
                    case "setReadOnly" -> { event("readOnly:" + a[0]); yield null; }
                    case "setAutoCommit" -> { event("autoCommit:" + a[0]); yield null; }
                    case "rollback" -> { event("rollback"); yield null; }
                    case "createStatement" -> { event("createStatement"); yield statement(); }
                    case "getMetaData" -> { event("getMetaData"); yield metadata(); }
                    case "getCatalog" -> "fixture";
                    case "isValid" -> true;
                    case "close" -> { event("connection.close"); yield null; }
                    default -> throw new UnsupportedOperationException(name);
                };
            });
        }

        private void event(String event) throws SQLException {
            events.add(event);
            if (event.equals(fail)) throw new SQLException("Fixture failure: " + event);
        }

        private Statement statement() {
            return proxy(Statement.class, (o,m,a) -> switch (m.getName()) {
                case "setQueryTimeout" -> { timeout = (int)a[0]; event("timeout:" + timeout); yield null; }
                case "setMaxRows" -> { maxRows = (int)a[0]; yield null; }
                case "execute" -> { event("execute:" + a[0]); yield hasResult; }
                case "getResultSet" -> resultSet();
                case "getUpdateCount" -> 7;
                case "close" -> { event("statement.close"); yield null; }
                default -> throw new UnsupportedOperationException(m.getName());
            });
        }

        private DatabaseMetaData metadata() {
            return proxy(DatabaseMetaData.class, (o,m,a) -> switch (m.getName()) {
                case "getSearchStringEscape" -> "\\";
                case "getSchemas", "getCatalogs", "getTables", "getColumns" -> { event(m.getName()); yield resultSet(); }
                default -> throw new UnsupportedOperationException(m.getName());
            });
        }

        private ResultSet resultSet() {
            int[] index = {0};
            ResultSetMetaData labels = proxy(ResultSetMetaData.class, (o,m,a) -> switch (m.getName()) {
                case "getColumnCount" -> columnCount;
                case "getColumnLabel" -> label != null ? label : columnCount == 1 ? "id" : "column_" + a[0];
                default -> throw new UnsupportedOperationException(m.getName());
            });
            return proxy(ResultSet.class, (o,m,a) -> switch (m.getName()) {
                case "getMetaData" -> labels;
                case "next" -> { rowsRead++; if (interruptRows) Thread.currentThread().interrupt(); yield ++index[0] <= available; }
                case "getString" -> nullCells ? null : cell != null ? cell : "value_" + index[0];
                case "getCharacterStream" -> nullCells ? null : new java.io.StringReader(cell != null ? cell : "value_" + index[0]);
                case "getStatement" -> null;
                case "close" -> { event("result.close"); yield null; }
                default -> throw new UnsupportedOperationException(m.getName());
            });
        }
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }
}
