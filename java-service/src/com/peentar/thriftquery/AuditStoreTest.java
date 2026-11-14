package com.peentar.thriftquery;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.Map;

public final class AuditStoreTest {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-audit-store");
        try {
            var store = new AuditStore(root);
            var alice = new GitHubAuth.User("1001", "alice");
            var bob = new GitHubAuth.User("2002", "bob");
            var first = new AuditStore.Event(alice, "query.execute", "server");
            first.connectionId = "private-a"; first.sqlOperation = "SELECT";
            store.begin(first);
            check(store.list("1001", false, Map.of()).toJson().contains("\"outcome\":\"pending\""), "Durable intent precedes completion");
            first.finishedAt = System.currentTimeMillis(); first.durationMs = 12L; first.httpStatus = 200; first.outcome = "success"; first.code = "OK"; first.returnedRows = 1L;
            store.finish(first);
            check(store.ownedQuery(first.requestId, "1001").returnedRows == 1, "Successful query can be correlated by its owner");
            check(store.ownedQuery(first.requestId, "2002") == null, "Foreign query references are hidden");
            var second = new AuditStore.Event(bob, "connection.connect", "server"); store.begin(second);
            second.finishedAt = System.currentTimeMillis(); second.durationMs = 7L; second.httpStatus = 502; second.outcome = "failure"; second.code = "HTTP_502"; store.finish(second);
            var anonymous = new AuditStore.Event(null, "auth.login", "server"); store.begin(anonymous);
            anonymous.finishedAt = System.currentTimeMillis(); anonymous.durationMs = 0L; anonymous.httpStatus = 303; anonymous.outcome = "denied"; anonymous.code = "AUTH_INVALID_STATE"; store.finish(anonymous);
            String own = store.list("1001", false, Map.of()).toJson();
            check(own.contains(first.requestId) && !own.contains(second.requestId) && !own.contains(anonymous.requestId), "Own scope filters both foreign and anonymous actors");
            try { store.list("1001", false, Map.of("scope", "all")); throw new AssertionError("All scope allowed"); } catch (AuditStore.Forbidden expected) { }
            try { store.list("1001", false, Map.of("userId", "2002")); throw new AssertionError("Actor filter allowed"); } catch (AuditStore.Forbidden expected) { }
            var all = store.list("9009", true, Map.of("scope", "all", "limit", "1"));
            check(all.events().size() == 1 && all.events().get(0).requestId.equals(anonymous.requestId) && all.nextCursor() != null, "Admin page includes anonymous actor in stable insertion order");
            var next = store.list("9009", true, Map.of("scope", "all", "limit", "1", "cursor", all.nextCursor()));
            check(next.events().size() == 1 && next.events().get(0).requestId.equals(second.requestId), "Cursor is exclusive and stable");
            check(store.list("9009", true, Map.of("scope", "all", "userId", "1001", "action", "query.execute", "outcome", "success", "connectionId", "private-a", "from", "2000-01-01T00:00:00Z", "to", "2100-01-01T00:00:00Z")).events().size() == 1, "Combined filters retain actor isolation");
            for (var invalid : java.util.List.of(Map.of("cursor", "0"), Map.of("limit", "101"), Map.of("from", "bad"), Map.of("scope", "invalid"), Map.of("action", "fake"), Map.of("outcome", "fake"), Map.of("ownerId", "2002"), Map.of("connectionId", "x' OR 1=1"))) {
                try { store.list("1001", true, invalid); throw new AssertionError("Invalid filter accepted: " + invalid); } catch (IllegalArgumentException expected) { }
            }
            check(new AuditStore(root).list("1001", false, Map.of()).events().size() == 1, "Restart preserves records");
            check(store.users().contains("alice") && store.users().contains("bob"), "Admin actors use recorded username snapshots");
            var renamed = new AuditStore.Event(new GitHubAuth.User("1001", "alice-renamed"), "auth.login", "server"); store.begin(renamed);
            check(store.list("1001", false, Map.of()).events().size() == 2 && store.list("3003", false, Map.of()).events().isEmpty(), "Username changes and reuse do not alter ownership");
            var pending = new java.util.ArrayList<java.util.concurrent.CompletableFuture<Void>>();
            for (int i = 0; i < 24; i++) {
                final var user = i % 2 == 0 ? alice : bob;
                pending.add(java.util.concurrent.CompletableFuture.runAsync(() -> store.begin(new AuditStore.Event(user, "metadata.tables", "server"))));
            }
            for (var task : pending) task.join();
            check(store.list("1001", false, Map.of()).events().size() == 14, "Concurrent actors remain correctly attributed");
            if (root.getFileSystem().supportedFileAttributeViews().contains("posix")) check(Files.getPosixFilePermissions(root.resolve("audit.sqlite")).equals(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")), "Audit database remains private");
            try (var db = DriverManager.getConnection("jdbc:sqlite:" + root.resolve("audit.sqlite")); var sql = db.createStatement()) { sql.executeUpdate("PRAGMA user_version=2"); }
            try { new AuditStore(root); throw new AssertionError("Future schema overwritten"); } catch (AuditStore.Unavailable expected) { }
            System.out.println("Persistent audit store tests passed");
        } finally { try (var files = Files.walk(root)) { for (var file : files.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(file); } }
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
