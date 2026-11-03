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
    private final AppConfig config;

    public JdbcService(AppConfig config) {
        this.config = config;
    }

    public QueryResult query(String sql) throws SQLException, ClassNotFoundException {
        if (!config.configured()) throw new IllegalStateException("Database connection is not configured");
        Class.forName(HIVE_DRIVER);
        long startedAt = System.currentTimeMillis();

        try (Connection connection = DriverManager.getConnection(config.jdbcUrl(), config.username(), config.password());
             Statement statement = connection.createStatement()) {
            try {
                connection.setReadOnly(true);
            } catch (SQLException ignored) {
                // Some Hive JDBC versions do not expose a read-only connection flag.
            }
            statement.setQueryTimeout(config.timeoutSeconds);
            boolean hasResult = statement.execute(sql);
            if (!hasResult) return QueryResult.empty(System.currentTimeMillis() - startedAt);

            try (ResultSet resultSet = statement.getResultSet()) {
                ResultSetMetaData metadata = resultSet.getMetaData();
                List<String> columns = uniqueColumnNames(metadata);
                List<List<String>> rows = new ArrayList<>();
                boolean truncated = false;
                while (resultSet.next()) {
                    if (rows.size() >= config.maxRows) {
                        truncated = true;
                        break;
                    }
                    List<String> row = new ArrayList<>();
                    for (int column = 1; column <= metadata.getColumnCount(); column++) {
                        row.add(resultSet.getString(column));
                    }
                    rows.add(row);
                }
                return new QueryResult(columns, rows, truncated, System.currentTimeMillis() - startedAt);
            }
        }
    }

    public List<String> databases() throws SQLException, ClassNotFoundException {
        QueryResult result = query(DATABASE_LIST_SQL);
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

    public record QueryResult(List<String> columns, List<List<String>> rows, boolean truncated, long durationMs) {
        static QueryResult empty(long durationMs) {
            return new QueryResult(List.of(), List.of(), false, durationMs);
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
                    .append('}')
                    .toString();
        }
    }
}
