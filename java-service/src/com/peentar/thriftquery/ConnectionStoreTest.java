package com.peentar.thriftquery;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

public final class ConnectionStoreTest {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-sqlite");
        try {
            Path data = root.resolve("data");
            ConnectionStore store = new ConnectionStore(data);
            ConnectionSettings settings = ConnectionSettings.fromJson("{\"type\":\"hive\",\"name\":\"Fixture's DB\",\"jdbcUrl\":\"jdbc:hive2://fixture/default;transportMode=http;token=url-secret\",\"username\":\"fixture\",\"password\":\"stored-secret\",\"database\":\"default\"}");
            store.save("fixture-id", settings);
            ConnectionStore reopened = new ConnectionStore(data);
            var restored = reopened.load().get("fixture-id");
            check(restored.profile().password().equals("stored-secret"), "Password round trip");
            check(restored.profile().jdbcUrl().equals(settings.profile().jdbcUrl()), "JDBC round trip");
            check(restored.profile().name().equals("Fixture's DB"), "Prepared statements handle quotes");
            String disk = new String(Files.readAllBytes(data.resolve("gridbase.sqlite")), StandardCharsets.ISO_8859_1);
            check(!disk.contains("stored-secret") && !disk.contains("url-secret") && !disk.contains("jdbc:hive2"), "Credentials encrypted on disk");
            AppConfig config = AppConfig.load(root, Map.of());
            AtomicInteger opened = new AtomicInteger();
            ConnectionRegistry registry = new ConnectionRegistry(profile -> new JdbcService(config, profile, () -> { opened.incrementAndGet(); throw new java.sql.SQLException("offline fixture"); }), reopened);
            check(registry.entries().size()==1 && !registry.entries().get(0).connected() && registry.defaultId()==null, "Startup restores disconnected profiles without a default");
            check(registry.details("fixture-id").profile().password().equals("stored-secret"), "Edit loads credentials");
            check(!registry.entries().get(0).toJson().contains("stored-secret"), "List must omit credentials");
            registry.save("fixture-id",ConnectionSettings.fromJson("{\"type\":\"postgresql\",\"name\":\"Updated\",\"host\":\"offline.fixture\",\"database\":\"app\",\"username\":\"fixture\",\"password\":\"updated-secret\"}"));
            check(registry.details("fixture-id").host().equals("offline.fixture"), "Offline save preserves form fields");
            check(new ConnectionStore(data).load().get("fixture-id").profile().password().equals("updated-secret"), "Update persists");
            ConnectionSettings keyNamed = ConnectionSettings.fromJson("{\"type\":\"hive\",\"name\":\"password\",\"jdbcUrl\":\"jdbc:hive2://fixture/default\",\"username\":\"fixture\",\"password\":\"exact-secret\"}");
            store.save("key-named", keyNamed);
            check(new ConnectionStore(data).load().get("key-named").profile().password().equals("exact-secret"), "Names matching JSON fields must preserve password");
            store.delete("key-named");
            check(opened.get() == 0, "Restore and offline save must not open remote connections");
            registry.delete("fixture-id");
            check(new ConnectionStore(data).load().isEmpty(), "Delete persists");
            Files.delete(data.resolve("credentials.key"));
            expectFailure(() -> new ConnectionStore(data));
            System.out.println("Encrypted SQLite connection store tests passed");
        } finally {
            try (var paths=Files.walk(root)) { for(Path path:paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); }
        }
    }
    private static void expectFailure(Runnable action) { try { action.run(); throw new AssertionError("Missing key must fail closed"); } catch (ConnectionStore.StoreException expected) { } }
    private static void check(boolean ok, String message) { if(!ok)throw new AssertionError(message); }
}
