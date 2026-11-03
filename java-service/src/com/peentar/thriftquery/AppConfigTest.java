package com.peentar.thriftquery;

import java.nio.file.Files;
import java.nio.file.Path;

public final class AppConfigTest {
    public static void main(String[] args) throws Exception {
        Path temporaryRoot = Files.createTempDirectory("thrift-query-config-test");
        try {
            Files.writeString(temporaryRoot.resolve(".env"),
                    "THRIFT_JDBC_URL=jdbc:hive2://legacy.example\n"
                            + "THRIFT_USERNAME=legacy-reader\n"
                            + "THRIFT_PASSWORD=legacy-secret\n");
            AppConfig config = AppConfig.load(temporaryRoot);
            check(!config.configured(), "credential values from .env must be ignored");
            config.configure("jdbc:hive2://spark.example:443/default;transportMode=http", "reader", "top-secret");

            check(config.configured(), "configured credentials should be ready");
            check("jdbc:hive2://spark.example:443/default;transportMode=http".equals(config.jdbcUrl()), "JDBC URL should be stored in memory");
            check("reader".equals(config.username()), "username should be stored in memory");
            check("top-secret".equals(config.password()), "password should be stored in memory");
            check(!config.redactedTarget().contains("top-secret"), "redacted target must not contain the password");

            expectInvalid(() -> config.configure("https://spark.example", "reader", "top-secret"));
            expectInvalid(() -> config.configure("jdbc:hive2://spark.example", "", "top-secret"));
            expectInvalid(() -> config.configure("jdbc:hive2://spark.example", "reader", ""));
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
