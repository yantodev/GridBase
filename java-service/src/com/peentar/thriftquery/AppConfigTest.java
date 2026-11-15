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
            ConnectionRegistry connections = new ConnectionRegistry(config, "1001");
            check(connections.entries().isEmpty() && connections.defaultId() == null, "Old .env Spark credentials must not create a default source");
            AppConfig overridden = AppConfig.load(root, Map.of("PORT", "4181", "QUERY_TIMEOUT_MS", "12000", "DEFAULT_QUERY_LIMIT", "25",
                    "THRIFT_JDBC_URL", "invalid-old-url", "THRIFT_USERNAME", "fixture", "THRIFT_PASSWORD", "fixture-secret", "DATABASE_TYPE", "old-type"));
            check(overridden.port == 4181 && overridden.timeoutSeconds == 12 && overridden.defaultQueryLimit == 25, "Environment overrides server settings");
            check(new ConnectionRegistry(overridden, "1001").entries().isEmpty(), "Old process credentials must not activate a source or break startup");
            Files.delete(root.resolve(".env"));
            AppConfig defaults = AppConfig.load(root, Map.of());
            check(defaults.port == 4173 && defaults.timeoutSeconds == 30 && defaults.defaultQueryLimit == 50, "Server defaults");
            check(!defaults.auth.configured() && defaults.auth.callbackUrl().equals("http://127.0.0.1:4173/auth/github/callback"), "Auth defaults remain locked until configured");
            Files.writeString(root.resolve(".env"), "APP_URL=https://gridbase.example/\nGITHUB_CLIENT_ID=file-id\nGITHUB_CLIENT_SECRET='file-secret'\nGITHUB_ALLOWED_USERS=Alice, BOB\n");
            AppConfig auth = AppConfig.load(root, Map.of("GITHUB_CLIENT_ID", "environment-id"));
            check(auth.auth.clientId().equals("environment-id") && auth.auth.clientSecret().equals("file-secret"), "Auth configuration respects environment overrides");
            check(auth.auth.secure() && auth.auth.appUrl().equals("https://gridbase.example") && auth.auth.allowedUsers().equals(java.util.Set.of("alice", "bob")), "Normalize origin and GitHub allowlist");
            check(AppConfig.load(root, Map.of("APP_URL", "https://GridBase.example:443/")).auth.appUrl().equals("https://gridbase.example"), "Origin matches the browser with a default port and mixed-case hostname");
            check(AppConfig.load(root, Map.of("LEGACY_CONNECTION_OWNER_ID", "1001")).legacyConnectionOwnerId.equals("1001"), "Trusted numeric migration target");
            check(AppConfig.load(root, Map.of("AUDIT_ADMIN_IDS", "1001, 2002,1001")).auditAdminIds.equals(java.util.Set.of("1001", "2002")), "Audit admins use distinct verified numeric IDs");
            for (String invalid : java.util.List.of("alice", "0", "1001,", "-1")) {
                try { AppConfig.load(root, Map.of("AUDIT_ADMIN_IDS", invalid)); throw new AssertionError("Invalid audit admin"); }
                catch (IllegalArgumentException expected) { }
            }
            for (String invalid : java.util.List.of("alice", "0", "-1")) {
                try { AppConfig.load(root, Map.of("LEGACY_CONNECTION_OWNER_ID", invalid)); throw new AssertionError("Invalid legacy owner"); }
                catch (IllegalArgumentException expected) { }
            }
            for (String invalid : java.util.List.of("http://gridbase.example", "https://gridbase.example/path", "https://user:secret@gridbase.example", "https://gridbase.example?next=evil")) {
                try { AppConfig.load(root, Map.of("APP_URL", invalid)); throw new AssertionError("Invalid APP_URL must be rejected"); }
                catch (IllegalArgumentException expected) { }
            }
        } finally {
            try (var paths = Files.walk(root)) { for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); }
        }
        System.out.println("App config tests passed");
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
