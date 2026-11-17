package com.peentar.thriftquery;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.DriverManager;
import java.sql.SQLFeatureNotSupportedException;
import java.io.Reader;
import java.io.IOException;
import java.util.Properties;
import java.util.Locale;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class JdbcService {
    static final String DATABASE_LIST_SQL = "SHOW NAMESPACES IN s3tables";
    static final int METADATA_LIMIT = 10_000;
    private final AppConfig config;
    private final ConnectionFactory connections;
    private final ConnectionProfile profile;
    private final ConnectionFactory injectedConnections;
    private final McpExecutionPolicy mcp;
    private volatile boolean metadataTruncated;

    public JdbcService(AppConfig config, ConnectionProfile profile) {
        this(config, profile, null);
    }

    JdbcService(AppConfig config, ConnectionProfile profile, ConnectionFactory connections) {
        this(config, profile, connections, null);
    }

    private JdbcService(AppConfig config, ConnectionProfile profile, ConnectionFactory connections, McpExecutionPolicy mcp) {
        this.config = config;
        this.profile = profile;
        this.injectedConnections = connections;
        this.mcp = mcp;
        this.connections = connections != null ? connections : () -> {
            if (profile == null) throw new IllegalStateException("Database connection is not configured");
            return mcp == null ? profile.open() : openMcpProfile();
        };
    }

    /** A new immutable per-call view; never mutate the ordinary workbench service. */
    public JdbcService forMcp(McpExecutionPolicy policy) {
        if (policy == null) throw new IllegalArgumentException("MCP execution policy is required");
        if (mcp != null) throw new IllegalStateException("MCP execution policy cannot be replaced");
        return new JdbcService(config, profile, injectedConnections, policy);
    }

    public boolean configured() { return profile != null; }

    public ConnectionProfile profile() { return profile; }

    /** Outcome of the latest metadata call on this per-call view, not authorization state. */
    public boolean metadataTruncated() { return metadataTruncated; }

    public void testConnection() throws SQLException, ClassNotFoundException {
        if (mcp != null) {
            try (McpConnection lease = mcpConnection()) {
                if (!lease.connection.isValid(mcp.timeoutSeconds(config.timeoutSeconds)))
                    throw new SQLException("Database menolak koneksi.");
                mcp.remainingNanos();
            }
            return;
        }
        try (Connection connection = connections.open()) {
            if (!connection.isValid(Math.max(1, config.timeoutSeconds))) {
                throw new SQLException("Database menolak koneksi.");
            }
        }
    }

    @FunctionalInterface
    interface ConnectionFactory {
        Connection open() throws SQLException, ClassNotFoundException;
    }

    public QueryResult query(String sql) throws SQLException, ClassNotFoundException {
        if (mcp != null) {
            mcp.remainingNanos();
            if (mcp.readOnly()) McpSqlPolicy.validate(sql, profile.type());
            else {
                SqlPolicy.Result checked = SqlPolicy.validate(sql, 20_000);
                if (!checked.ok()) throw new IllegalArgumentException(checked.error());
                sql = checked.sql();
            }
            QueryLimits.Plan plan = QueryLimits.plan(sql, config.defaultQueryLimit);
            return mcpQuery(plan.sql(), Math.min(plan.rowLimit(), mcp.rowLimit()));
        }
        QueryLimits.Plan plan = QueryLimits.plan(sql, config.defaultQueryLimit);
        return query(plan.sql(), plan.rowLimit());
    }

    private QueryResult query(String sql, int rowLimit) throws SQLException, ClassNotFoundException {
        if (!configured()) throw new IllegalStateException("Database connection is not configured");
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

    private Connection openMcpProfile() throws SQLException, ClassNotFoundException {
        mcp.remainingNanos();
        Class.forName(profile.type().driverClass());
        Properties properties = mcpDriverProperties(profile.type(), mcp.timeoutSeconds(config.timeoutSeconds));
        String url = profile.type().isHive() ? profile.jdbcUrl() : mcpJdbcUrl(profile.jdbcUrl(), properties);
        properties.setProperty("user", profile.username());
        properties.setProperty("password", profile.password());
        // Hive 2.3.9 has no supported JDBC connect/socket-timeout property. The
        // caller's bounded worker must retain its slot until late work cleans up.
        return DriverManager.getConnection(url, properties);
    }

    static Properties mcpDriverProperties(DatabaseType type, int seconds) {
        Properties properties = new Properties();
        if (type == DatabaseType.POSTGRESQL) {
            for (String name : List.of("connectTimeout", "socketTimeout", "loginTimeout", "cancelSignalTimeout"))
                properties.setProperty(name, String.valueOf(seconds));
            properties.setProperty("readOnlyMode", "transaction");
        } else if (type == DatabaseType.MYSQL) {
            properties.setProperty("connectTimeout", String.valueOf(seconds * 1000L));
            properties.setProperty("socketTimeout", String.valueOf(seconds * 1000L));
        }
        return properties;
    }

    static String mcpJdbcUrl(String url, Properties timeouts) {
        // URL parameters override Properties: replace conflicting values in this
        // per-call URL, never change ConnectionProfile.open() or global timeouts.
        String[] parts = url.split("\\?", 2);
        List<String> parameters = new ArrayList<>();
        Set<String> replaced = new HashSet<>();
        for (String key : timeouts.stringPropertyNames()) replaced.add(key.toLowerCase(Locale.ROOT));
        if (parts.length > 1) for (String parameter : parts[1].split("&")) {
            String key = java.net.URLDecoder.decode(parameter.split("=", 2)[0], java.nio.charset.StandardCharsets.UTF_8).toLowerCase(Locale.ROOT);
            if (!replaced.contains(key)) parameters.add(parameter);
        }
        for (String key : new java.util.TreeSet<>(timeouts.stringPropertyNames())) parameters.add(key + "=" + timeouts.getProperty(key));
        return parts[0] + "?" + String.join("&", parameters);
    }

    private final class McpConnection implements AutoCloseable {
        private final Connection connection;
        private final boolean rollback;

        McpConnection(Connection connection) { this.connection = connection; this.rollback = mcp.readOnly() && !profile.type().isHive(); }

        @Override public void close() throws SQLException {
            try { if (rollback) connection.rollback(); }
            finally { connection.close(); }
        }
    }

    private McpConnection mcpConnection() throws SQLException, ClassNotFoundException {
        mcp.remainingNanos();
        McpConnection lease = new McpConnection(connections.open());
        try {
            mcp.remainingNanos(); // Also close a connection returned after the deadline.
            if (lease.rollback) {
                lease.connection.setReadOnly(true);
                lease.connection.setAutoCommit(false);
                try (Statement setup = lease.connection.createStatement()) {
                    setup.setQueryTimeout(mcp.timeoutSeconds(config.timeoutSeconds));
                    setup.execute("SET TRANSACTION READ ONLY");
                }
            }
            mcp.remainingNanos();
            return lease;
        } catch (SQLException | RuntimeException | Error failure) {
            try { lease.close(); } catch (SQLException | RuntimeException cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
    }

    private QueryResult mcpQuery(String sql, int rowLimit) throws SQLException, ClassNotFoundException {
        if (!configured()) throw new IllegalStateException("Database connection is not configured");
        long started = System.nanoTime();
        try (McpConnection lease = mcpConnection(); Statement statement = lease.connection.createStatement()) {
            statement.setQueryTimeout(mcp.timeoutSeconds(config.timeoutSeconds));
            statement.setMaxRows(rowLimit + 1);
            boolean hasResult = statement.execute(sql);
            mcp.remainingNanos();
            if (!hasResult) return QueryResult.empty((System.nanoTime() - started) / 1_000_000L, statement.getUpdateCount());
            try (ResultSet result = statement.getResultSet()) {
                ResultSetMetaData metadata = result.getMetaData();
                if (metadata.getColumnCount() > 512) throw new SQLException("MCP result has too many columns");
                SizeBudget budget = new SizeBudget();
                List<String> columns = new ArrayList<>();
                Set<String> seen = new HashSet<>();
                try {
                    for (int index = 1; index <= metadata.getColumnCount(); index++) {
                        String name = checkedText(metadata.getColumnLabel(index));
                        if (name == null || name.isBlank()) name = "column_" + index;
                        String unique = name;
                        for (int suffix = 2; !seen.add(unique); suffix++) unique = name + "_" + suffix;
                        budget.add(unique);
                        columns.add(unique);
                    }
                } catch (ResultTooLarge limit) {
                    return new QueryResult(List.of(), List.of(), true, (System.nanoTime() - started) / 1_000_000L, null);
                }
                List<List<String>> rows = new ArrayList<>();
                boolean truncated = false;
                while (nextMcp(result)) {
                    if (rows.size() >= rowLimit) { truncated = true; break; }
                    List<String> row = new ArrayList<>();
                    try {
                        for (int column = 1; column <= columns.size(); column++) {
                            mcp.remainingNanos();
                            String value = boundedText(result, column);
                            budget.add(columns.get(column - 1)); // Serialized object repeats column names.
                            budget.add(value);
                            row.add(value);
                        }
                    } catch (ResultTooLarge limit) { truncated = true; break; }
                    rows.add(java.util.Collections.unmodifiableList(row));
                }
                mcp.remainingNanos();
                return new QueryResult(List.copyOf(columns), java.util.Collections.unmodifiableList(rows), truncated,
                        (System.nanoTime() - started) / 1_000_000L, null);
            }
        }
    }

    private boolean nextMcp(ResultSet result) throws SQLException {
        mcp.remainingNanos();
        boolean next = result.next();
        mcp.remainingNanos();
        return next;
    }

    private static final class ResultTooLarge extends SQLException {
        ResultTooLarge() { super("MCP response size limit exceeded"); }
    }

    /** Reserve room for tool/JSON wrappers; worst-case JSON escaping per UTF-16 char. */
    private static final class SizeBudget {
        private long bytes = 1024;
        void add(String value) throws ResultTooLarge {
            bytes += value == null ? 8 : 8L + value.length() * 6L;
            if (bytes > McpExecutionPolicy.MAX_RESPONSE_BYTES * 3L / 4L) throw new ResultTooLarge();
        }
    }

    private String boundedText(ResultSet result, Object column) throws SQLException {
        // Hive's installed driver does not implement character streams. Its row
        // is already materialized by the driver; bound retained application data.
        if (profile.type().isHive()) return checkedText(column instanceof Integer index ? result.getString(index) : result.getString((String) column));
        try (Reader reader = column instanceof Integer index ? result.getCharacterStream(index) : result.getCharacterStream((String) column)) {
            if (reader == null) return null;
            StringBuilder value = new StringBuilder();
            char[] buffer = new char[2048];
            int count;
            while ((count = reader.read(buffer)) != -1) {
                mcp.remainingNanos();
                if (value.length() + count > 65_536) throw new ResultTooLarge();
                value.append(buffer, 0, count);
            }
            return value.toString();
        } catch (SQLFeatureNotSupportedException unsupported) {
            return checkedText(column instanceof Integer index ? result.getString(index) : result.getString((String) column));
        } catch (IOException failure) { throw new SQLException("Unable to read bounded MCP value", failure); }
    }

    private String checkedText(String value) throws ResultTooLarge {
        if (value != null && value.length() > 65_536) throw new ResultTooLarge();
        return value;
    }

    public List<String> databases() throws SQLException, ClassNotFoundException {
        metadataTruncated = false;
        if (!configured()) throw new IllegalStateException("Database connection is not configured");
        if (!profile.type().isHive()) return jdbcSchemas();
        QueryResult result = mcp == null ? query(DATABASE_LIST_SQL, METADATA_LIMIT) : mcpQuery(DATABASE_LIST_SQL, mcp.metadataLimit());
        if (mcp != null) metadataTruncated = result.truncated();
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
        metadataTruncated = false;
        if (!configured()) throw new IllegalStateException("Database connection is not configured");
        if (!profile.type().isHive()) return jdbcTables(namespace);
        String sql = "SHOW TABLES IN `s3tables`." + quoteIdentifier(namespace);
        QueryResult result = mcp == null ? query(sql, METADATA_LIMIT) : mcpQuery(sql, mcp.metadataLimit());
        if (mcp != null) metadataTruncated = result.truncated();
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
        metadataTruncated = false;
        if (!configured()) throw new IllegalStateException("Database connection is not configured");
        if (!profile.type().isHive()) return jdbcColumns(namespace, table);
        String sql = "DESCRIBE `s3tables`." + quoteIdentifier(namespace) + "." + quoteIdentifier(table);
        QueryResult result = mcp == null ? query(sql, METADATA_LIMIT) : mcpQuery(sql, mcp.metadataLimit());
        if (mcp != null) metadataTruncated = result.truncated();
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

    private List<String> jdbcSchemas() throws SQLException, ClassNotFoundException {
        if (mcp != null) return mcpMetadataNames(null);
        try (Connection connection = connections.open()) {
            DatabaseMetaData metadata = connection.getMetaData();
            List<String> values = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            if (profile.type() == DatabaseType.MYSQL) {
                try (ResultSet result = metadata.getCatalogs()) {
                    while (result.next()) addUnique(values, seen, result.getString("TABLE_CAT"));
                }
            } else {
                try (ResultSet result = metadata.getSchemas()) {
                    while (result.next()) addUnique(values, seen, result.getString("TABLE_SCHEM"));
                }
            }
            return values;
        }
    }

    private List<String> jdbcTables(String namespace) throws SQLException, ClassNotFoundException {
        quoteIdentifier(namespace);
        if (mcp != null) return mcpMetadataNames(namespace);
        try (Connection connection = connections.open()) {
            DatabaseMetaData metadata = connection.getMetaData();
            String catalog = profile.type() == DatabaseType.MYSQL ? namespace : connection.getCatalog();
            String schema = profile.type() == DatabaseType.MYSQL ? null : metadataPattern(metadata, namespace);
            List<String> tables = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            try (ResultSet result = metadata.getTables(catalog, schema, "%", new String[]{"TABLE", "VIEW", "SYSTEM TABLE"})) {
                while (result.next()) addUnique(tables, seen, result.getString("TABLE_NAME"));
            }
            return tables;
        }
    }

    private List<Column> jdbcColumns(String namespace, String table) throws SQLException, ClassNotFoundException {
        quoteIdentifier(namespace);
        quoteIdentifier(table);
        if (mcp != null) return mcpMetadataColumns(namespace, table);
        try (Connection connection = connections.open()) {
            DatabaseMetaData metadata = connection.getMetaData();
            String catalog = profile.type() == DatabaseType.MYSQL ? namespace : connection.getCatalog();
            String schema = profile.type() == DatabaseType.MYSQL ? null : metadataPattern(metadata, namespace);
            List<Column> columns = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            try (ResultSet result = metadata.getColumns(catalog, schema, metadataPattern(metadata, table), "%")) {
                while (result.next()) {
                    String name = result.getString("COLUMN_NAME");
                    if (name != null && seen.add(name)) {
                        String type = result.getString("TYPE_NAME");
                        String comment = result.getString("REMARKS");
                        columns.add(new Column(name, type == null ? "" : type, comment == null ? "" : comment));
                    }
                }
            }
            return columns;
        }
    }

    private List<String> mcpMetadataNames(String namespace) throws SQLException, ClassNotFoundException {
        try (McpConnection lease = mcpConnection()) {
            Connection connection = lease.connection;
            DatabaseMetaData metadata = connection.getMetaData();
            boolean mysql = profile.type() == DatabaseType.MYSQL;
            String label = namespace != null ? "TABLE_NAME" : mysql ? "TABLE_CAT" : "TABLE_SCHEM";
            try (ResultSet result = namespace != null
                    ? metadata.getTables(mysql ? namespace : connection.getCatalog(), mysql ? null : metadataPattern(metadata, namespace),
                            "%", new String[]{"TABLE", "VIEW", "SYSTEM TABLE"})
                    : mysql ? metadata.getCatalogs() : metadata.getSchemas()) {
                List<String> values = new ArrayList<>();
                Set<String> seen = new HashSet<>();
                SizeBudget budget = new SizeBudget();
                int scanned = 0;
                // Bound scanning independently too (duplicates/blank rows included).
                while (nextMcp(result)) {
                    if (scanned++ >= mcp.metadataLimit()) { metadataTruncated = true; break; }
                    try {
                        String value = boundedText(result, label);
                        budget.add(value);
                        addUnique(values, seen, value);
                    } catch (ResultTooLarge limit) { metadataTruncated = true; break; }
                }
                mcp.remainingNanos();
                return List.copyOf(values);
            }
        }
    }

    private List<Column> mcpMetadataColumns(String namespace, String table) throws SQLException, ClassNotFoundException {
        try (McpConnection lease = mcpConnection()) {
            Connection connection = lease.connection;
            DatabaseMetaData metadata = connection.getMetaData();
            boolean mysql = profile.type() == DatabaseType.MYSQL;
            try (ResultSet result = metadata.getColumns(mysql ? namespace : connection.getCatalog(), mysql ? null : metadataPattern(metadata, namespace), metadataPattern(metadata, table), "%")) {
                List<Column> columns = new ArrayList<>();
                Set<String> seen = new HashSet<>();
                SizeBudget budget = new SizeBudget();
                int scanned = 0;
                while (nextMcp(result)) {
                    if (scanned++ >= mcp.metadataLimit()) { metadataTruncated = true; break; }
                    try {
                        String name = boundedText(result, "COLUMN_NAME");
                        String type = boundedText(result, "TYPE_NAME");
                        String comment = boundedText(result, "REMARKS");
                        budget.add(name); budget.add(type); budget.add(comment);
                        if (name != null && seen.add(name)) columns.add(new Column(name, type == null ? "" : type, comment == null ? "" : comment));
                    } catch (ResultTooLarge limit) { metadataTruncated = true; break; }
                }
                mcp.remainingNanos();
                return List.copyOf(columns);
            }
        }
    }

    /** JDBC schema/table arguments are search patterns, unlike literal catalog arguments. */
    private static String metadataPattern(DatabaseMetaData metadata, String literal) throws SQLException {
        String escape = metadata.getSearchStringEscape();
        if (escape == null || escape.isEmpty()) {
            if (literal.indexOf('_') >= 0 || literal.indexOf('%') >= 0)
                throw new SQLException("Driver cannot escape literal metadata identifiers");
            return literal;
        }
        StringBuilder pattern = new StringBuilder();
        for (int index = 0; index < literal.length();) {
            if (literal.startsWith(escape, index)) {
                pattern.append(escape).append(escape);
                index += escape.length();
            } else {
                char character = literal.charAt(index++);
                if (character == '_' || character == '%') pattern.append(escape);
                pattern.append(character);
            }
        }
        return pattern.toString();
    }

    private static void addUnique(List<String> values, Set<String> seen, String value) {
        if (value != null && !value.isBlank() && seen.add(value)) values.add(value);
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
