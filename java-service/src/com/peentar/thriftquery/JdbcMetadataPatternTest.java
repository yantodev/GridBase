package com.peentar.thriftquery;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/** JDBC pattern semantics with similarly named fixtures; no remote database. */
public final class JdbcMetadataPatternTest {
    private record Target(String name, String similar, String escaped) { }
    private record Table(String schema, String name, String column) { }
    private static int checks;

    public static void main(String[] args) throws Exception {
        var root = Files.createTempDirectory("jdbc-literal-metadata");
        try {
            AppConfig config = AppConfig.load(root, Map.of());
            for (DatabaseType type : List.of(DatabaseType.POSTGRESQL, DatabaseType.MYSQL)) {
                for (boolean mcp : List.of(false, true)) {
                    for (var target : List.of(new Target("sales_2026", "salesX2026", "sales\\_2026"),
                            new Target("sales%2026", "salesOther2026", "sales\\%2026"),
                            new Target("sales\\_2026", "sales_2026", "sales\\\\\\_2026"))) {
                        Fixture fixture = new Fixture(type, target.name(), "\\");
                        fixture.tables.add(new Table(target.name(), "correct_table", "id"));
                        fixture.tables.add(new Table(target.similar(), "wrong_table", "other_id"));
                        JdbcService service = fixture.service(config, mcp);
                        check(service.tables(target.name()).equals(List.of("correct_table")), type + " mcp=" + mcp + " schema must be literal: " + target.name());
                        check(Objects.equals(fixture.catalogArgument, type == DatabaseType.MYSQL ? target.name() : "fixture_catalog"), "Catalog remains literal");
                        check(Objects.equals(fixture.schemaArgument, type == DatabaseType.MYSQL ? null : target.escaped()), "Only JDBC schema pattern is escaped");
                        check(fixture.tableArgument.equals("%"), "Intentional all-table wildcard remains");
                    }
                    for (var target : List.of(new Target("orders_2026", "ordersX2026", "orders\\_2026"),
                            new Target("orders%2026", "ordersOther2026", "orders\\%2026"),
                            new Target("orders\\_2026", "orders_2026", "orders\\\\\\_2026"))) {
                        Fixture fixture = new Fixture(type, "sales_2026", "\\");
                        // Put conflicting rows first: name-only deduplication must not hide contamination.
                        fixture.tables.add(new Table("salesX2026", target.name(), "foreign_schema_column"));
                        fixture.tables.add(new Table("sales_2026", target.similar(), "foreign_table_column"));
                        fixture.tables.add(new Table("sales_2026", target.name(), "exact_column"));
                        List<JdbcService.Column> columns = fixture.service(config, mcp).columns("sales_2026", target.name());
                        check(columns.equals(List.of(new JdbcService.Column("exact_column", "INTEGER", "fixture"))), type + " mcp=" + mcp + " table description must be exact: " + columns);
                        check(Objects.equals(fixture.schemaArgument, type == DatabaseType.MYSQL ? null : "sales\\_2026"), "Describe schema pattern is escaped");
                        check(fixture.tableArgument.equals(target.escaped()), "Describe table pattern is escaped");
                        check(fixture.columnArgument.equals("%"), "Intentional all-column wildcard remains");
                    }
                    Fixture custom = new Fixture(type, "sales!_2026", "!");
                    custom.tables.add(new Table("sales!_2026", "orders!%2026", "exact_column"));
                    check(custom.service(config, mcp).columns("sales!_2026", "orders!%2026").size() == 1, "Use the driver's escape string, not a hard-coded backslash");
                    check(custom.tableArgument.equals("orders!!!%2026"), "Escape the escape character itself before wildcard characters");
                    Fixture unsupported = new Fixture(type, "sales", "");
                    try {
                        unsupported.service(config, mcp).columns("sales", "orders_2026");
                        throw new AssertionError("Cannot safely describe wildcard identifier without driver escape support");
                    } catch (SQLException expected) { checks++; }
                }
            }
        } finally { Files.delete(root); }
        System.out.println("JDBC literal metadata pattern tests passed (checks=" + checks + ")");
    }

    private static final class Fixture {
        final DatabaseType type;
        final String catalog, escape;
        final List<Table> tables = new ArrayList<>();
        String catalogArgument, schemaArgument, tableArgument, columnArgument;
        Fixture(DatabaseType type, String namespace, String escape) {
            this.type = type; this.catalog = type == DatabaseType.MYSQL ? namespace : "fixture_catalog"; this.escape = escape;
        }
        JdbcService service(AppConfig config, boolean mcp) {
            String url = type == DatabaseType.MYSQL ? "jdbc:mysql://fixture/db" : "jdbc:postgresql://fixture/db";
            var service = new JdbcService(config, new ConnectionProfile(type, "Fixture", url, "dummy", "dummy"), this::connection);
            return mcp ? service.forMcp(new McpExecutionPolicy("fixture-generation", true, 500, 1000, System.nanoTime() + TimeUnit.SECONDS.toNanos(5))) : service;
        }
        Connection connection() {
            DatabaseMetaData metadata = proxy(DatabaseMetaData.class, (p, method, args) -> switch (method.getName()) {
                case "getSearchStringEscape" -> escape;
                case "getTables", "getColumns" -> {
                    catalogArgument = (String) args[0]; schemaArgument = (String) args[1]; tableArgument = (String) args[2];
                    boolean columns = method.getName().equals("getColumns");
                    if (columns) columnArgument = (String) args[3];
                    List<Map<String, String>> result = new ArrayList<>();
                    for (Table table : tables) {
                        String tableCatalog = type == DatabaseType.MYSQL ? table.schema() : catalog;
                        if (!tableCatalog.equals(catalogArgument) || !matches(table.schema(), schemaArgument, escape) || !matches(table.name(), tableArgument, escape)) continue;
                        result.add(Map.of("TABLE_NAME", table.name(), "TABLE_SCHEM", table.schema(), "COLUMN_NAME", table.column(), "TYPE_NAME", "INTEGER", "REMARKS", "fixture"));
                    }
                    yield rows(result);
                }
                default -> throw new UnsupportedOperationException(method.getName());
            });
            Statement setup = proxy(Statement.class, (p, method, args) -> switch (method.getName()) {
                case "setQueryTimeout", "close" -> null;
                case "execute" -> false;
                default -> throw new UnsupportedOperationException(method.getName());
            });
            return proxy(Connection.class, (p, method, args) -> switch (method.getName()) {
                case "getMetaData" -> metadata;
                case "getCatalog" -> catalog;
                case "createStatement" -> setup;
                case "setReadOnly", "setAutoCommit", "rollback", "close" -> null;
                default -> throw new UnsupportedOperationException(method.getName());
            });
        }
    }
    private static ResultSet rows(List<Map<String, String>> rows) {
        int[] position = {-1};
        return proxy(ResultSet.class, (p, method, args) -> switch (method.getName()) {
            case "next" -> ++position[0] < rows.size();
            case "getString" -> rows.get(position[0]).get((String) args[0]);
            case "getCharacterStream" -> new java.io.StringReader(rows.get(position[0]).get((String) args[0]));
            case "close" -> null;
            default -> throw new UnsupportedOperationException(method.getName());
        });
    }
    private static boolean matches(String literal, String pattern, String escape) {
        if (pattern == null) return true;
        StringBuilder regex = new StringBuilder();
        for (int i = 0; i < pattern.length(); i++) {
            char c = pattern.charAt(i);
            if (!escape.isEmpty() && pattern.startsWith(escape, i)) {
                i += escape.length();
                if (i >= pattern.length()) return false;
                regex.append(Pattern.quote(String.valueOf(pattern.charAt(i))));
            } else if (c == '_') regex.append('.');
            else if (c == '%') regex.append(".*");
            else regex.append(Pattern.quote(String.valueOf(c)));
        }
        return literal.matches(regex.toString());
    }
    private static void check(boolean condition, String message) { checks++; if (!condition) throw new AssertionError(message); }
    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }
}
