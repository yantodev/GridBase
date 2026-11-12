package com.peentar.thriftquery;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.Locale;

public record ConnectionProfile(DatabaseType type, String name, String jdbcUrl, String username, String password) {
    private static final int MAX_NAME_LENGTH = 80;
    private static final int MAX_JDBC_URL_LENGTH = 2048;
    private static final int MAX_USERNAME_LENGTH = 256;
    private static final int MAX_PASSWORD_LENGTH = 2048;

    public ConnectionProfile {
        if (type == null) throw new IllegalArgumentException("Tipe database wajib dipilih.");
        require(name, "Nama koneksi", MAX_NAME_LENGTH);
        require(jdbcUrl, "JDBC URL", MAX_JDBC_URL_LENGTH);
        require(username, "Username", MAX_USERNAME_LENGTH);
        require(password, "Password", MAX_PASSWORD_LENGTH);
        type.validateUrl(jdbcUrl);
    }

    public Connection open() throws SQLException, ClassNotFoundException {
        Class.forName(type.driverClass());
        return DriverManager.getConnection(jdbcUrl, username, password);
    }

    public String redactedUrl() {
        return jdbcUrl.replaceAll("(?i)((?:^|[;?&])(password|token|secret)=)[^;&]*", "$1••••••");
    }

    public String safeJson() {
        return "{\"type\":" + JsonUtil.quote(type.id())
                + ",\"label\":" + JsonUtil.quote(type.label())
                + ",\"name\":" + JsonUtil.quote(name)
                + ",\"target\":" + JsonUtil.quote(redactedUrl()) + "}";
    }

    public static ConnectionProfile fromJson(String json) {
        String typeValue = JsonUtil.stringField(json, "type");
        DatabaseType type = DatabaseType.parse(typeValue);
        String name = JsonUtil.stringFieldOrDefault(json, "name", "").trim();
        String jdbcUrl = JsonUtil.stringFieldOrDefault(json, "jdbcUrl", "").trim();
        String username = JsonUtil.stringFieldOrDefault(json, "username", "");
        String password = JsonUtil.stringFieldOrDefault(json, "password", "");
        if (jdbcUrl.isBlank()) {
            String host = JsonUtil.stringFieldOrDefault(json, "host", "").trim();
            String portValue = JsonUtil.stringFieldOrDefault(json, "port", String.valueOf(type.defaultPort())).trim();
            String database = JsonUtil.stringFieldOrDefault(json, "database", "").trim();
            boolean ssl = JsonUtil.booleanFieldOrDefault(json, "ssl", false);
            jdbcUrl = buildUrl(type, host, portValue, database, ssl);
            if (name.isBlank()) name = type.label() + " · " + host + "/" + database;
        }
        if (name.isBlank()) name = type.label();
        return new ConnectionProfile(type, name, jdbcUrl, username, password);
    }

    public static ConnectionProfile fromEnvironment(DatabaseType type, String jdbcUrl, String username, String password) {
        if (jdbcUrl == null || jdbcUrl.isBlank() || username == null || username.isBlank() || password == null || password.isBlank()) {
            return null;
        }
        DatabaseType resolved = type == null ? DatabaseType.infer(jdbcUrl) : type;
        if (resolved == null) throw new IllegalArgumentException("Tipe database tidak dapat ditentukan dari JDBC URL.");
        return new ConnectionProfile(resolved, resolved.label(), jdbcUrl.trim(), username.trim(), password);
    }

    static String buildUrl(DatabaseType type, String host, String portValue, String database, boolean ssl) {
        requireHostPart(host, "Host");
        requireHostPart(database, "Database");
        int port;
        try {
            port = Integer.parseInt(portValue);
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("Port harus berupa angka.");
        }
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Port harus berada di antara 1 dan 65535.");
        String encodedDatabase = encodePathPart(database);
        return switch (type) {
            case POSTGRESQL -> "jdbc:postgresql://" + host + ":" + port + "/" + encodedDatabase + "?sslmode=" + (ssl ? "require" : "disable");
            case MYSQL -> "jdbc:mysql://" + host + ":" + port + "/" + encodedDatabase + "?useSSL=" + ssl + "&allowPublicKeyRetrieval=true&serverTimezone=UTC";
            case HIVE -> throw new IllegalArgumentException("Spark Thrift / Hive membutuhkan JDBC URL lengkap.");
        };
    }

    private static void require(String value, String label, int maxLength) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(label + " wajib diisi.");
        if (value.length() > maxLength) throw new IllegalArgumentException(label + " terlalu panjang.");
        if (value.chars().anyMatch(character -> character < 32 || character == 127)) {
            throw new IllegalArgumentException(label + " mengandung karakter kontrol.");
        }
    }

    private static void requireHostPart(String value, String label) {
        require(value, label, 256);
        if (value.contains("/") || value.contains("?") || value.contains("#") || value.contains(";")) {
            throw new IllegalArgumentException(label + " tidak valid.");
        }
    }

    private static String encodePathPart(String value) {
        StringBuilder encoded = new StringBuilder();
        for (char character : value.toCharArray()) {
            if (Character.isLetterOrDigit(character) || ".-_~".indexOf(character) >= 0) encoded.append(character);
            else encoded.append(String.format(Locale.ROOT, "%%%02X", (int) character));
        }
        return encoded.toString();
    }
}
