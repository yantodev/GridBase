package com.peentar.thriftquery;

import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** A driver that ignores interrupts must not free its bounded MCP worker slot. */
public final class McpConcurrencyTest {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("mcp-capacity");
        AppConfig config = AppConfig.load(root, Map.of("QUERY_TIMEOUT_MS", "1000"));
        CountDownLatch entered = new CountDownLatch(4), release = new CountDownLatch(1);
        ConnectionWorkspaces workspaces = new ConnectionWorkspaces(config, profile -> new JdbcService(config, profile, () -> {
            entered.countDown();
            boolean done = false;
            while (!done) { try { release.await(); done = true; } catch (InterruptedException deliberatelyIgnored) { } }
            throw new java.sql.SQLException("dummy driver failure");
        }));
        ThriftQueryServer server = new ThriftQueryServer(config, workspaces);
        try {
            var registry = workspaces.forOwner("1001");
            registry.save("blocking", ConnectionSettings.fromJson("{\"type\":\"postgresql\",\"name\":\"Blocking fixture\",\"jdbcUrl\":\"jdbc:postgresql://fixture/db\",\"username\":\"dummy\",\"password\":\"dummy\"}"));
            var profile = registry.mcp("blocking");
            var created = new McpTokenStore(config.dataDir).create(new GitHubAuth.User("1001", "fixture"), "capacity", "full_access", 30, List.of(new McpTokenStore.Grant("blocking", profile.generation(), false)));
            server.start(0);
            var client = HttpClient.newHttpClient();
            var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.port() + "/mcp")).header("Authorization", "Bearer " + created.secret())
                    .header("Accept", "application/json, text/event-stream").header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"execute_query\",\"arguments\":{\"connectionId\":\"blocking\",\"sql\":\"SELECT 1\"}}}")).build();
            List<CompletableFuture<HttpResponse<String>>> futures = new ArrayList<>();
            for (int i = 0; i < 4; i++) futures.add(client.sendAsync(request, HttpResponse.BodyHandlers.ofString()));
            if (!entered.await(5, TimeUnit.SECONDS)) throw new AssertionError("Four fixture workers must enter JDBC");
            for (var future : futures) {
                var response = future.get(5, TimeUnit.SECONDS);
                if (response.statusCode() != 200 || !response.body().contains("Batas waktu")) throw new AssertionError(response.body());
            }
            var saturated = client.send(request, HttpResponse.BodyHandlers.ofString());
            if (!saturated.body().contains("Kapasitas MCP penuh")) throw new AssertionError("Cancelled driver released worker capacity: " + saturated.body());
            release.countDown();
            // Functional condition, not a fixed sleep: await four workers terminating their cancelled tasks.
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            boolean recovered = false;
            do {
                var response = client.send(request, HttpResponse.BodyHandlers.ofString());
                if (!response.body().contains("Kapasitas MCP penuh")) { recovered = true; break; }
            } while (System.nanoTime() < deadline);
            if (!recovered) throw new AssertionError("MCP worker capacity did not recover after actual driver exit");
            System.out.println("MCP worker deadline and saturation tests passed");
        } finally { release.countDown(); server.stop(); try (var paths = Files.walk(root)) { for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); } }
    }
}
