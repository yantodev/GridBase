package com.peentar.thriftquery;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class JdbcService {
    private static final String HIVE_DRIVER = "org.apache.hive.jdbc.HiveDriver";
    static final String DATABASE_LIST_SQL = "SHOW NAMESPACES IN s3tables";
    static final int METADATA_LIMIT = 10_000;
    private final AppConfig config;
    private final ConnectionFactory connections;

    public JdbcService(AppConfig config) {
        this(config, () -> {
            Class.forName(HIVE_DRIVER);
            return DriverManager.getConnection(config.jdbcUrl(), config.username(), config.password());
        });
    }

    JdbcService(AppConfig config, ConnectionFactory connections) {
        this.config = config;
        this.connections = connections;
    }

    @FunctionalInterface
    interface ConnectionFactory {
        Connection open() throws SQLException, ClassNotFoundException;
    }

    public QueryResult query(String sql) throws SQLException, ClassNotFoundException {
        QueryLimits.Plan plan = QueryLimits.plan(sql, config.defaultQueryLimit);
        return query(plan.sql(), plan.rowLimit());
    }

    private QueryResult query(String sql, int rowLimit) throws SQLException, ClassNotFoundException {
        if (!config.configured()) throw new IllegalStateException("Database connection is not configured");
        long startedAt = System.currentTimeMillis();

        try (Connection connection = connections.open();
             Statement statement = connection.createStatement()) {
            try {
                connection.setReadOnly(false);
            } catch (SQLException ignored) {
                // Some Hive JDBC versions do not expose the connection flag.
            }
            statement.setQueryTimeout(config.timeoutSeconds);
            boolean hasResult = statement.execute(sql);
            if (!hasResult) return QueryResult.empty(System.currentTimeMillis() - startedAt, statement.getUpdateCount());

            try (ResultSet resultSet = statement.getResultSet()) {
                ResultSetMetaData metadata = resultSet.getMetaData();
                List<String> columns = uniqueColumnNames(metadata);
                List<List<String>> rows = new ArrayList<>();
                boolean truncated = false;
                while (resultSet.next()) {
                    if (rows.size() >= rowLimit) {
                        truncated = true;
                        break;
                    }
                    List<String> row = new ArrayList<>();
                    for (int column = 1; column <= metadata.getColumnCount(); column++) {
                        row.add(resultSet.getString(column));
                    }
                    rows.add(row);
                }
                return new QueryResult(columns, rows, truncated, System.currentTimeMillis() - startedAt, null);
            }
        }
    }

    public List<String> databases() throws SQLException, ClassNotFoundException {
        QueryResult result = query(DATABASE_LIST_SQL, METADATA_LIMIT);
        int databaseColumn = findDatabaseColumn(result.columns());
        List<String> databases = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (List<String> row : result.rows()) {
            if (databaseColumn >= row.size()) continue;
            String value = row.get(databaseColumn);
            if (value != null && !value.isBlank() && seen.add(value)) databases.add(value);
        }
        return databases;
    }

    static String quoteIdentifier(String value) {
        if (value == null || value.isBlank() || value.length() > 256 || value.chars().anyMatch(c -> c < 32 || c == 127)) {
            throw new IllegalArgumentException("Identifier wajib diisi, maksimal 256 karakter, tanpa karakter kontrol.");
        }
        return "`" + value.replace("`", "``") + "`";
    }

    public List<String> tables(String namespace) throws SQLException, ClassNotFoundException {
        QueryResult result = query("SHOW TABLES IN `s3tables`." + quoteIdentifier(namespace), METADATA_LIMIT);
        int column = result.columns().size() > 1 ? 1 : 0;
        for (int i = 0; i < result.columns().size(); i++) {
            if (result.columns().get(i).matches("(?i)table_?name")) column = i;
        }
        List<String> tables = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (List<String> row : result.rows()) {
            if (column >= row.size()) continue;
            String name = row.get(column);
            if (name != null && !name.isBlank() && seen.add(name)) tables.add(name);
        }
        return tables;
    }

    public List<Column> columns(String namespace, String table) throws SQLException, ClassNotFoundException {
        QueryResult result = query("DESCRIBE `s3tables`." + quoteIdentifier(namespace) + "." + quoteIdentifier(table), METADATA_LIMIT);
        List<Column> columns = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (List<String> row : result.rows()) {
            if (row.isEmpty()) continue;
            String name = row.get(0);
            String type = row.size() > 1 && row.get(1) != null ? row.get(1) : "";
            boolean marker = name != null && name.trim().startsWith("#") && (type.isBlank()
                    || name.trim().matches("(?i)#\\s*col_name") && type.trim().equalsIgnoreCase("data_type"));
            if (name == null || name.isBlank() || marker || !seen.add(name)) continue;
            columns.add(new Column(name, type, row.size() > 2 && row.get(2) != null ? row.get(2) : ""));
        }
        return columns;
    }

    public record Column(String name, String type, String comment) {
        public String toJson() {
            return "{\"name\":" + JsonUtil.quote(name) + ",\"type\":" + JsonUtil.quote(type)
                    + ",\"comment\":" + JsonUtil.quote(comment) + "}";
        }
    }

    @Deprecated
    public List<String> namespaces() throws SQLException, ClassNotFoundException {
        return databases();
    }

    private static int findDatabaseColumn(List<String> columns) {
        for (int index = 0; index < columns.size(); index++) {
            if (columns.get(index).matches("(?i)namespace|database(name)?|schema")) return index;
        }
        return 0;
    }

    private static List<String> uniqueColumnNames(ResultSetMetaData metadata) throws SQLException {
        List<String> columns = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int index = 1; index <= metadata.getColumnCount(); index++) {
            String name = metadata.getColumnLabel(index);
            if (name == null || name.isBlank()) name = "column_" + index;
            String uniqueName = name;
            int suffix = 2;
            while (!seen.add(uniqueName)) uniqueName = name + "_" + suffix++;
            columns.add(uniqueName);
        }
        return columns;
    }

    public record QueryResult(List<String> columns, List<List<String>> rows, boolean truncated, long durationMs, Long updateCount) {
        static QueryResult empty(long durationMs, int updateCount) {
            return new QueryResult(List.of(), List.of(), false, durationMs, updateCount < 0 ? null : (long) updateCount);
        }

        public String toJson() {
            StringBuilder json = new StringBuilder("{\"columns\":");
            json.append(JsonUtil.stringArray(columns)).append(",\"rows\":[");
            for (int rowIndex = 0; rowIndex < rows.size(); rowIndex++) {
                if (rowIndex > 0) json.append(',');
                json.append('{');
                List<String> row = rows.get(rowIndex);
                for (int columnIndex = 0; columnIndex < columns.size(); columnIndex++) {
                    if (columnIndex > 0) json.append(',');
                    json.append(JsonUtil.quote(columns.get(columnIndex))).append(':');
                    json.append(JsonUtil.quote(columnIndex < row.size() ? row.get(columnIndex) : null));
                }
                json.append('}');
            }
            return json.append("],\"rowCount\":")
                    .append(rows.size())
                    .append(",\"durationMs\":")
                    .append(durationMs)
                    .append(",\"truncated\":")
                    .append(truncated)
                    .append(",\"updateCount\":")
                    .append(updateCount)
                    .append('}')
                    .toString();
        }
    }
}
