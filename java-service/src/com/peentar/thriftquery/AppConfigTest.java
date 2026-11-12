package com.peentar.thriftquery;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

public final class AppConfigTest {
    public static void main(String[] args) throws Exception {
        Path temporaryRoot = Files.createTempDirectory("thrift-query-config-test");
        try {
            Files.writeString(temporaryRoot.resolve(".env"),
                    "# Local connection\n"
                            + "THRIFT_JDBC_URL=\"jdbc:hive2://spark.example:443/default;transportMode=http;token=hidden-token\"\n"
                            + "THRIFT_USERNAME='reader'\n"
                            + "THRIFT_PASSWORD=\" top-secret=#value \"\n");
            AppConfig config = AppConfig.load(temporaryRoot, Map.of());

            check(config.configured(), "credentials from .env should be ready at startup");
            check(config.defaultQueryLimit == 50, "default result limit should be 50 rows");
            check(AppConfig.load(temporaryRoot, Map.of("DEFAULT_QUERY_LIMIT", "25")).defaultQueryLimit == 25, "result limit should remain configurable");
            check(config.jdbcUrl().startsWith("jdbc:hive2://spark.example:443/default;transportMode=http"), "JDBC URL should load from .env");
            check("reader".equals(config.username()), "username should load from .env without quotes");
            check(" top-secret=#value ".equals(config.password()), "quoted password must preserve whitespace and special characters");
            check(!config.redactedTarget().contains("top-secret"), "redacted target must not contain the password");
            check(!config.redactedTarget().contains("hidden-token"), "redacted target must hide URL tokens");

            AppConfig overridden = AppConfig.load(temporaryRoot, Map.of(
                    "THRIFT_JDBC_URL", "jdbc:hive2://override.example/default",
                    "THRIFT_USERNAME", "environment-reader", "THRIFT_PASSWORD", "environment-secret"));
            check("jdbc:hive2://override.example/default".equals(overridden.jdbcUrl()), "environment URL should override .env");
            check("environment-reader".equals(overridden.username()), "environment username should override .env");
            check("environment-secret".equals(overridden.password()), "environment password should override .env");

            expectInvalid(() -> AppConfig.load(temporaryRoot, Map.of("THRIFT_JDBC_URL", "https://spark.example")));
            expectInvalid(() -> AppConfig.load(temporaryRoot, Map.of("THRIFT_PASSWORD", "x".repeat(2049))));

            Files.writeString(temporaryRoot.resolve(".env"), "THRIFT_JDBC_URL=\nTHRIFT_USERNAME=\nTHRIFT_PASSWORD=\n");
            check(!AppConfig.load(temporaryRoot, Map.of()).configured(), "empty credentials should leave the server unconfigured");
            Files.delete(temporaryRoot.resolve(".env"));
            check(!AppConfig.load(temporaryRoot, Map.of()).configured(), "missing .env should leave the server unconfigured");
        } finally {
            Files.deleteIfExists(temporaryRoot.resolve(".env"));
            Files.deleteIfExists(temporaryRoot);
        }
        System.out.println("App config tests passed");
    }

    private static void expectInvalid(Runnable action) {
        try {
            action.run();
            throw new AssertionError("Expected invalid configuration");
        } catch (IllegalArgumentException expected) {
            // Expected validation failure.
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
