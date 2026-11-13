package com.peentar.thriftquery;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

public final class AppConfig {
    public final String host;
    public final int port;
    public final int timeoutSeconds;
    public final int defaultQueryLimit;
    public final Path publicDir;
    public final Path dataDir;
    final AuthConfig auth;

    private AppConfig(String host, int port, int timeoutSeconds, int defaultQueryLimit, Path publicDir, AuthConfig auth) {
        this.host = host;
        this.port = port;
        this.timeoutSeconds = timeoutSeconds;
        this.defaultQueryLimit = defaultQueryLimit;
        this.publicDir = publicDir;
        this.dataDir = publicDir.getParent().resolve("data");
        this.auth = auth;
    }

    public static AppConfig load(Path projectRoot) {
        return load(projectRoot, System.getenv());
    }

    static AppConfig load(Path projectRoot, Map<String, String> environment) {
        Map<String, String> fileValues = readDotEnv(projectRoot.resolve(".env"));
        int port = boundedInt(value("PORT", environment, fileValues, "4173"), 1, 65535, 4173);
        return new AppConfig(
                environment.getOrDefault("HOST", "127.0.0.1"),
                port,
                boundedInt(value("QUERY_TIMEOUT_MS", environment, fileValues, "30000"), 1000, 120000, 30000) / 1000,
                boundedInt(value("DEFAULT_QUERY_LIMIT", environment, fileValues, "50"), 1, 10000, 50),
                projectRoot.resolve("public").toAbsolutePath().normalize(),
                new AuthConfig(value("APP_URL", environment, fileValues, "http://127.0.0.1:" + port),
                        value("GITHUB_CLIENT_ID", environment, fileValues, ""),
                        value("GITHUB_CLIENT_SECRET", environment, fileValues, ""),
                        AuthConfig.users(value("GITHUB_ALLOWED_USERS", environment, fileValues, "")))
        );
    }

    private static String value(String key, Map<String, String> environment, Map<String, String> fileValues, String fallback) {
        String environmentValue = environment.get(key);
        return environmentValue != null && !environmentValue.isBlank()
                ? environmentValue
                : fileValues.getOrDefault(key, fallback);
    }

    private static int boundedInt(String value, int min, int max, int fallback) {
        try {
            return Math.min(Math.max(Integer.parseInt(value), min), max);
        } catch (NumberFormatException ignored) {
            return fallback;
        }
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
                String value = trimmed.substring(separator + 1).trim();
                if (value.length() >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith("\"") && value.endsWith("\"")))) {
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
