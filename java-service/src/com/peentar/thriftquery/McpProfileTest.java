package com.peentar.thriftquery;

import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.util.Comparator;
import java.util.Map;
import java.util.UUID;

/** Saved-profile MCP authorization tests; fixture credentials only. */
public final class McpProfileTest {
    public static void main(String[] args) throws Exception {
        legacySettingsDoNotGrantReadOnly();
        generationIsServerControlled();
        storedSettingsRoundTripGeneration();
        savedProfilesHaveDurableGenerations();
        legacyMigrationCannotIssueAnUndurableGeneration();
        System.out.println("MCP profile tests passed");
    }

    private static void legacySettingsDoNotGrantReadOnly() throws Exception {
        ConnectionSettings settings = ConnectionSettings.fromJson(json("fixture-password", false, null));
        check(!settings.mcpReadOnly(), "Legacy profiles must not be declared read-only");
    }

    private static void generationIsServerControlled() throws Exception {
        String attackerGeneration = "11111111-1111-4111-8111-111111111111";
        ConnectionSettings settings = ConnectionSettings.fromJson(json("fixture-password", true, attackerGeneration));
        check(settings.generation() == null, "Browser must never select a profile generation");
        check(settings.mcpReadOnly(), "Read-only declaration must survive parsing");
    }

    private static void storedSettingsRoundTripGeneration() {
        String expected = UUID.randomUUID().toString();
        ConnectionSettings settings = ConnectionSettings.fromStoredJson(json("fixture-password", true, expected));
        check(settings.generation().equals(expected), "Trusted stored loader must retain generation");
        check(ConnectionSettings.fromStoredJson(settings.toJson()).equals(settings), "Stored settings must round-trip");
        check(ConnectionSettings.fromJson(settings.toJson()).generation() == null, "Even valid stored generations are ignored by browser parser");
        check(!settings.toString().contains("fixture-password"), "Settings string must redact credentials");
        try { ConnectionSettings.fromStoredJson(json("fixture-password", true, "malformed")); throw new AssertionError("Malformed stored generation accepted"); }
        catch (IllegalArgumentException expectedFailure) { }
    }

    private static void savedProfilesHaveDurableGenerations() throws Exception {
        Path root = Files.createTempDirectory("gridbase-mcp-profile");
        try {
            AppConfig config = AppConfig.load(root, Map.of());
            ConnectionRegistry.ServiceFactory factory = profile -> new JdbcService(config, profile, () ->
                    (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class[]{Connection.class},
                            (proxy, method, arguments) -> switch (method.getName()) {
                                case "isValid" -> true;
                                case "close" -> null;
                                default -> throw new UnsupportedOperationException(method.getName());
                            }));
            ConnectionStore store = new ConnectionStore(root, "1001");
            ConnectionRegistry registry = new ConnectionRegistry(factory, store);
            registry.save("chosen", ConnectionSettings.fromJson(json("fixture-password", true, null)));
            String first = generation(registry, "chosen");
            var profile = registry.mcp("chosen");
            check(profile.id().equals("chosen") && profile.readOnly() && profile.service().profile().name().equals("fixture"), "MCP profile returns exact saved settings");
            String summary = registry.entries().get(0).toJson();
            check(summary.contains("\"mcpReadOnly\":true") && !summary.contains("fixture-password") && !summary.contains("generation"), "Connection summary exposes read-only declaration without credentials or grants");
            check(UUID.fromString(first).version() == 4, "Saved profiles need random UUID generations");
            check(registry.defaultId() == null, "Saved disconnected profiles must not become browser defaults");
            expectMissing(() -> generation(registry, ""));
            expectMissing(() -> generation(registry, null));
            expectMissing(() -> generation(registry, "unknown"));
            registry.connect("chosen", ConnectionSettings.fromJson(json("fixture-password", true, UUID.randomUUID().toString())));
            check(first.equals(generation(registry, "chosen")), "Unchanged reconnect preserves generation despite client input");
            registry.disconnect("chosen");
            check(first.equals(generation(registry, "chosen")), "Workbench disconnect must not revoke MCP access");
            registry.save("chosen", ConnectionSettings.fromJson(json("fixture-password", true, null)));
            check(first.equals(generation(registry, "chosen")), "Unchanged saves retain existing grants");
            registry.save("chosen", ConnectionSettings.fromJson(json("changed-fixture-password", true, first)));
            String changed = generation(registry, "chosen");
            check(!first.equals(changed), "Changed credentials must invalidate old grants");
            registry.save("chosen", ConnectionSettings.fromJson(json("changed-fixture-password", false, changed)));
            String writable = generation(registry, "chosen");
            check(!changed.equals(writable), "Changing read-only declaration must invalidate grants");
            registry.delete("chosen");
            registry.save("chosen", ConnectionSettings.fromJson(json("changed-fixture-password", false, writable)));
            String recreated = generation(registry, "chosen");
            check(!writable.equals(recreated), "Same-ID recreation must never revive old grants");
            store.delete("chosen");
            expectMissing(() -> generation(registry, "chosen"));
            registry.save("chosen", ConnectionSettings.fromJson(json("changed-fixture-password", false, null)));
            recreated = generation(registry, "chosen");
            ConnectionRegistry foreign = new ConnectionRegistry(factory, new ConnectionStore(root, "2002"));
            expectMissing(() -> generation(foreign, "chosen"));
            ConnectionRegistry restarted = new ConnectionRegistry(factory, new ConnectionStore(root, "1001"));
            check(recreated.equals(generation(restarted, "chosen")), "Generation must persist across restart");
            store.save("legacy", ConnectionSettings.fromJson(json("fixture-password", false, null)));
            ConnectionRegistry migrated = new ConnectionRegistry(factory, store);
            String legacy = generation(migrated, "legacy");
            check(legacy.equals(generation(new ConnectionRegistry(factory, store), "legacy")), "Legacy generation must be durable before issuance");
            ConnectionRegistry stale = new ConnectionRegistry(factory, store);
            ConnectionRegistry current = new ConnectionRegistry(factory, store);
            current.save("chosen", ConnectionSettings.fromJson(json("new-fixture-password", false, null)));
            expectMissing(() -> generation(stale, "chosen"));
            check(!recreated.equals(generation(current, "chosen")), "A second registry's credential edit cannot preserve stale authorization");
        } finally {
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    private static void legacyMigrationCannotIssueAnUndurableGeneration() throws Exception {
        Path root = Files.createTempDirectory("gridbase-mcp-profile");
        try {
            ConnectionStore store = new ConnectionStore(root, "1001");
            store.save("legacy", ConnectionSettings.fromJson(json("fixture-password", false, null)));
            try (var db = java.sql.DriverManager.getConnection("jdbc:sqlite:" + root.resolve("gridbase.sqlite")); var sql = db.createStatement()) {
                sql.executeUpdate("CREATE TRIGGER refuse_generation BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END");
            }
            AppConfig config = AppConfig.load(root, Map.of());
            try {
                new ConnectionRegistry(profile -> new JdbcService(config, profile), store);
                throw new AssertionError("Failed legacy generation persistence must prevent registry creation");
            } catch (ConnectionStore.StoreException expected) { }
            check(store.load().get("legacy").generation() == null, "Failed migration must not claim generation was persisted");
        } finally {
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    private static String generation(ConnectionRegistry registry, String id) throws Exception {
        return registry.mcp(id).generation();
    }

    @FunctionalInterface private interface Checked { void run() throws Exception; }
    private static void expectMissing(Checked action) throws Exception {
        try { action.run(); throw new AssertionError("Expected unknown connection"); }
        catch (ConnectionRegistry.UnknownConnectionException expected) { }
    }

    private static String json(String password, boolean readOnly, String generation) {
        return "{\"type\":\"postgresql\",\"name\":\"fixture\",\"host\":\"fixture\",\"port\":\"5432\","
                + "\"database\":\"app\",\"username\":\"fixture\",\"password\":" + JsonUtil.quote(password)
                + (readOnly ? ",\"mcpReadOnly\":true" : "")
                + (generation == null ? "" : ",\"generation\":" + JsonUtil.quote(generation)) + "}";
    }

    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
