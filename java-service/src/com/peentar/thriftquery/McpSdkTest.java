package com.peentar.thriftquery;

import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Optional external SDK process against a disposable local dummy server. */
public final class McpSdkTest {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("mcp-sdk");
        AppConfig config = AppConfig.load(root, Map.of());
        ConnectionWorkspaces workspaces = new ConnectionWorkspaces(config, profile -> new JdbcService(config, profile, McpSdkTest::fixture));
        ThriftQueryServer server = new ThriftQueryServer(config, workspaces);
        try {
            var registry = workspaces.forOwner("1001");
            registry.save("sdk-fixture", ConnectionSettings.fromJson("{\"type\":\"hive\",\"name\":\"SDK fixture\",\"jdbcUrl\":\"jdbc:hive2://fixture/default\",\"username\":\"dummy\",\"password\":\"dummy\",\"mcpReadOnly\":true}"));
            var profile = registry.mcp("sdk-fixture");
            var created = new McpTokenStore(config.dataDir).create(new GitHubAuth.User("1001", "fixture"), "sdk", "read_only", 30, List.of(new McpTokenStore.Grant(profile.id(), profile.generation(), true)));
            server.start(0);
            ProcessBuilder builder = new ProcessBuilder("node", "test/mcp-sdk-probe.js");
            builder.environment().put("GRIDBASE_MCP_FIXTURE_URL", "http://127.0.0.1:" + server.port() + "/mcp");
            builder.environment().put("GRIDBASE_MCP_FIXTURE_TOKEN", created.secret());
            builder.inheritIO();
            Process process = builder.start();
            if (!process.waitFor(30, TimeUnit.SECONDS)) { process.destroyForcibly(); throw new AssertionError("SDK probe timeout"); }
            if (process.exitValue() != 0) throw new AssertionError("SDK probe failed");
        } finally { server.stop(); try (var paths = Files.walk(root)) { for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); } }
    }
    static java.sql.Connection fixture() {
        var metadata = proxy(java.sql.ResultSetMetaData.class, (method, args) -> switch (method) {
            case "getColumnCount" -> 1;
            case "getColumnLabel", "getColumnName" -> "fixture";
            default -> null;
        });
        int[] position = {-1}, count = {1};
        var rows = proxy(java.sql.ResultSet.class, (method, args) -> switch (method) {
            case "getMetaData" -> metadata;
            case "next" -> ++position[0] < count[0];
            case "getString" -> "1";
            case "getCharacterStream" -> new java.io.StringReader("1");
            default -> null;
        });
        var statement = proxy(java.sql.Statement.class, (method, args) -> switch (method) {
            case "execute" -> { position[0] = -1; count[0] = ((String) args[0]).startsWith("SHOW") ? 1601 : 1; yield true; }
            case "getResultSet" -> rows;
            default -> null;
        });
        return proxy(java.sql.Connection.class, (method, args) -> switch (method) {
            case "createStatement" -> statement;
            case "isValid" -> true;
            default -> null;
        });
    }
    @FunctionalInterface private interface Handler { Object invoke(String method, Object[] args); }
    private static <T> T proxy(Class<T> type, Handler handler) {
        return type.cast(java.lang.reflect.Proxy.newProxyInstance(type.getClassLoader(), new Class[]{type}, (instance, method, args) -> {
            Object value = handler.invoke(method.getName(), args);
            if (value != null || !method.getReturnType().isPrimitive() || method.getReturnType() == void.class) return value;
            if (method.getReturnType() == boolean.class) return false;
            if (method.getReturnType() == long.class) return 0L;
            return 0;
        }));
    }
}
