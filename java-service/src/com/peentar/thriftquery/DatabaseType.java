package com.peentar.thriftquery;

public enum DatabaseType {
    HIVE("hive", "Spark Thrift / Hive", "org.apache.hive.jdbc.HiveDriver", 10000),
    POSTGRESQL("postgresql", "PostgreSQL", "org.postgresql.Driver", 5432),
    MYSQL("mysql", "MySQL", "com.mysql.cj.jdbc.Driver", 3306);

    private final String id;
    private final String label;
    private final String driverClass;
    private final int defaultPort;

    DatabaseType(String id, String label, String driverClass, int defaultPort) {
        this.id = id;
        this.label = label;
        this.driverClass = driverClass;
        this.defaultPort = defaultPort;
    }

    public String id() {
        return id;
    }

    public String label() {
        return label;
    }

    public String driverClass() {
        return driverClass;
    }

    public int defaultPort() {
        return defaultPort;
    }

    public boolean isHive() {
        return this == HIVE;
    }

    public static DatabaseType parse(String raw) {
        if (raw == null || raw.isBlank()) return null;
        return switch (raw.trim().toLowerCase()) {
            case "hive", "hive2", "spark", "spark-thrift" -> HIVE;
            case "postgres", "postgresql" -> POSTGRESQL;
            case "mysql" -> MYSQL;
            default -> throw new IllegalArgumentException("Tipe database tidak didukung: " + raw);
        };
    }

    public static DatabaseType infer(String jdbcUrl) {
        if (jdbcUrl == null) return null;
        if (jdbcUrl.startsWith("jdbc:hive2:")) return HIVE;
        if (jdbcUrl.startsWith("jdbc:postgresql:")) return POSTGRESQL;
        if (jdbcUrl.startsWith("jdbc:mysql:")) return MYSQL;
        return null;
    }

    public void validateUrl(String jdbcUrl) {
        String prefix = switch (this) {
            case HIVE -> "jdbc:hive2:";
            case POSTGRESQL -> "jdbc:postgresql:";
            case MYSQL -> "jdbc:mysql:";
        };
        if (jdbcUrl == null || !jdbcUrl.startsWith(prefix)) {
            throw new IllegalArgumentException("JDBC URL harus menggunakan " + prefix + ".");
        }
    }
}
