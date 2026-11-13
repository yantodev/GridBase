package com.peentar.thriftquery;

import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class ConnectionRegistryTest {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-registry");
        try {
            AppConfig config = AppConfig.load(root, Map.of());
            List<String> executed = new ArrayList<>();
            ConnectionRegistry registry = new ConnectionRegistry(profile -> new JdbcService(config, profile, () -> {
                if (profile.name().equals("broken")) throw new SQLException("fixture failure");
                Statement statement = (Statement) Proxy.newProxyInstance(Statement.class.getClassLoader(), new Class[]{Statement.class}, (p, m, a) -> switch (m.getName()) {
                    case "execute" -> { executed.add(profile.type().id() + ":" + profile.name() + ":" + a[0]); yield false; }
                    case "getUpdateCount" -> 1;
                    case "setQueryTimeout", "close" -> null;
                    default -> throw new UnsupportedOperationException(m.getName());
                });
                return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class[]{Connection.class}, (p, m, a) -> switch (m.getName()) {
                    case "isValid" -> true;
                    case "createStatement" -> statement;
                    case "setReadOnly", "close" -> null;
                    default -> throw new UnsupportedOperationException(m.getName());
                });
            }));
            var first = registry.connect("", profile("postgresql", "same name"));
            var second = registry.connect("", profile("mysql", "same name"));
            check(!first.id().equals(second.id()), "Names must not be used as IDs");
            check(registry.entries().size() == 2, "Both connections must coexist");
            JdbcService captured = registry.require(first.id());
            registry.require(first.id()).query("UPDATE first_table SET id=1");
            registry.require(second.id()).query("DELETE FROM second_table");
            registry.connect(second.id(), profile("mysql", "reconnected"));
            captured.query("CREATE TABLE keep_origin (id INT)");
            check(executed.equals(List.of("postgresql:same name:UPDATE first_table SET id=1", "mysql:same name:DELETE FROM second_table", "postgresql:same name:CREATE TABLE keep_origin (id INT)")), executed.toString());
            try { registry.connect(first.id(), profile("postgresql", "broken")); throw new AssertionError("Expected failure"); }
            catch (SQLException expected) { check(registry.require(first.id()) == captured, "Failed reconnect must preserve working connection"); }
            registry.disconnect(second.id());
            check(registry.require(first.id()) == captured, "Disconnect must preserve other connections");
            expectMissing(() -> registry.require(second.id()));
            expectMissing(() -> registry.require("unknown"));
            check(registry.require("") == captured, "Legacy default is stable");
            registry.disconnect(first.id());
            expectMissing(() -> registry.require(first.id()));
            try { registry.require(""); throw new AssertionError("Missing default"); } catch (IllegalStateException expected) { }
            AppConfig env = AppConfig.load(root, Map.of("THRIFT_JDBC_URL", "jdbc:hive2://fixture/default", "THRIFT_USERNAME", "fixture", "THRIFT_PASSWORD", "fixture-secret"));
            ConnectionRegistry defaults = new ConnectionRegistry(env, "1001");
            check(defaults.defaultId() == null && defaults.entries().isEmpty(), "No startup source, even with old Spark environment settings");
            System.out.println("Multi-connection registry tests passed");
        } finally {
            try (var paths = Files.walk(root)) { for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); }
        }
    }
    private static ConnectionProfile profile(String type, String name) {
        return ConnectionProfile.fromJson("{\"type\":\"" + type + "\",\"name\":\"" + name + "\",\"host\":\"fixture\",\"database\":\"app\",\"username\":\"fixture\",\"password\":\"fixture-secret\"}");
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
    private static void expectMissing(Runnable action) {
        try { action.run(); throw new AssertionError("Expected unknown connection"); } catch (ConnectionRegistry.UnknownConnectionException expected) { }
    }
}
