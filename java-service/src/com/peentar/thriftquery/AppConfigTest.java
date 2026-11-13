package com.peentar.thriftquery;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

public final class AppConfigTest {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-config-test");
        try {
            Files.writeString(root.resolve(".env"), "PORT=4180\nQUERY_TIMEOUT_MS=45000\nDEFAULT_QUERY_LIMIT=75\n"
                    + "THRIFT_JDBC_URL=jdbc:hive2://old-spark/default\nTHRIFT_USERNAME=fixture\nTHRIFT_PASSWORD=fixture-secret\n");
            AppConfig config = AppConfig.load(root, Map.of());
            check(config.port == 4180 && config.timeoutSeconds == 45 && config.defaultQueryLimit == 75, "Load server settings from .env");
            ConnectionRegistry connections = new ConnectionRegistry(config);
            check(connections.entries().isEmpty() && connections.defaultId() == null, "Old .env Spark credentials must not create a default source");
            AppConfig overridden = AppConfig.load(root, Map.of("PORT", "4181", "QUERY_TIMEOUT_MS", "12000", "DEFAULT_QUERY_LIMIT", "25",
                    "THRIFT_JDBC_URL", "invalid-old-url", "THRIFT_USERNAME", "fixture", "THRIFT_PASSWORD", "fixture-secret", "DATABASE_TYPE", "old-type"));
            check(overridden.port == 4181 && overridden.timeoutSeconds == 12 && overridden.defaultQueryLimit == 25, "Environment overrides server settings");
            check(new ConnectionRegistry(overridden).entries().isEmpty(), "Old process credentials must not activate a source or break startup");
            Files.delete(root.resolve(".env"));
            AppConfig defaults = AppConfig.load(root, Map.of());
            check(defaults.port == 4173 && defaults.timeoutSeconds == 30 && defaults.defaultQueryLimit == 50, "Server defaults");
        } finally { Files.deleteIfExists(root.resolve(".env")); Files.deleteIfExists(root); }
        System.out.println("App config tests passed");
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
