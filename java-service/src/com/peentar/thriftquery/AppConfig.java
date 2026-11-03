package com.peentar.thriftquery;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

public final class AppConfig {
    private static final int MAX_JDBC_URL_LENGTH = 2048;
    private static final int MAX_USERNAME_LENGTH = 256;
    private static final int MAX_PASSWORD_LENGTH = 2048;
    private static final Set<String> RUNTIME_CREDENTIAL_KEYS = Set.of("THRIFT_JDBC_URL", "THRIFT_USERNAME", "THRIFT_PASSWORD");

    public final String host;
    public final int port;
    public final int timeoutSeconds;
    public final int maxRows;
    public final Path publicDir;

    private volatile String jdbcUrl;
    private volatile String username;
    private volatile String password;

    private AppConfig(String host, int port, String jdbcUrl, String username, String password,
                      int timeoutSeconds, int maxRows, Path publicDir) {
        this.host = host;
        this.port = port;
        this.jdbcUrl = jdbcUrl;
        this.username = username;
        this.password = password;
        this.timeoutSeconds = timeoutSeconds;
        this.maxRows = maxRows;
        this.publicDir = publicDir;
    }

    public static AppConfig load(Path projectRoot) {
        Map<String, String> fileValues = readDotEnv(projectRoot.resolve(".env"));
        return new AppConfig(
                value("HOST", fileValues, "127.0.0.1"),
                boundedInt(value("PORT", fileValues, "4173"), 1, 65535, 4173),
                "",
                "",
                "",
                boundedInt(value("QUERY_TIMEOUT_MS", fileValues, "30000"), 1000, 120000, 30000) / 1000,
                boundedInt(value("MAX_QUERY_ROWS", fileValues, "1000"), 1, 10000, 1000),
                projectRoot.resolve("public").toAbsolutePath().normalize()
        );
    }

    public boolean configured() {
        return !jdbcUrl().isBlank() && !username().isBlank() && !password().isBlank();
    }

    public String jdbcUrl() {
        return jdbcUrl;
    }

    public String username() {
        return username;
    }

    public String password() {
        return password;
    }

    public synchronized void configure(String jdbcUrl, String username, String password) {
        String normalizedJdbcUrl = requireValue(jdbcUrl, "JDBC URL", MAX_JDBC_URL_LENGTH).trim();
        String normalizedUsername = requireValue(username, "username", MAX_USERNAME_LENGTH).trim();
        String normalizedPassword = requireValue(password, "password", MAX_PASSWORD_LENGTH);
        if (!normalizedJdbcUrl.startsWith("jdbc:hive2://")) {
            throw new IllegalArgumentException("JDBC URL harus menggunakan jdbc:hive2://.");
        }
        this.jdbcUrl = normalizedJdbcUrl;
        this.username = normalizedUsername;
        this.password = normalizedPassword;
    }

    public String redactedTarget() {
        String configuredUrl = jdbcUrl();
        if (configuredUrl.isBlank()) return null;
        return configuredUrl.replaceAll("(?i)((?:^|[;?&])(password|token|secret)=)[^;&]*", "$1••••••");
    }

    private static String value(String key, Map<String, String> fileValues, String fallback) {
        String environment = System.getenv(key);
        return environment != null && !environment.isBlank()
                ? environment
                : fileValues.getOrDefault(key, fallback);
    }

    private static int boundedInt(String value, int min, int max, int fallback) {
        try {
            return Math.min(Math.max(Integer.parseInt(value), min), max);
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static String requireValue(String value, String label, int maxLength) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(label + " wajib diisi.");
        if (value.length() > maxLength) throw new IllegalArgumentException(label + " terlalu panjang.");
        return value;
    }

    private static Map<String, String> readDotEnv(Path path) {
        Map<String, String> values = new HashMap<>();
        if (!Files.isRegularFile(path)) return values;
        try {
            for (String line : Files.readAllLines(path)) {
                String trimmed = line.trim();
                if (trimmed.isEmpty() || trimmed.startsWith("#")) continue;
                int separator = trimmed.indexOf('=');
                if (separator <= 0) continue;
                String key = trimmed.substring(0, separator).trim();
                if (RUNTIME_CREDENTIAL_KEYS.contains(key)) continue;
                String value = trimmed.substring(separator + 1).trim();
                if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith("\"") && value.endsWith("\""))) {
                    value = value.substring(1, value.length() - 1);
                }
                values.put(key, value);
            }
        } catch (IOException ignored) {
            // Missing or unreadable optional .env falls back to process environment.
        }
        return values;
    }
}
