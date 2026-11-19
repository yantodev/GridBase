package com.peentar.thriftquery;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.sql.DriverManager;
import java.nio.charset.StandardCharsets;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.ArrayList;
import java.util.UUID;

/** Real SQLite fixtures; never uses application data or live identities. */
public final class McpTokenStoreTest {
    public static void main(String[] args) throws Exception {
        createsPrivateStore();
        persistsOnlySecretHashes();
        ownerIsolationRevocationAndExpiry();
        validatesIssuanceAndImmutableGrants();
        activeTokenLimitIsAtomic();
        storageFailureIsNotAnInvalidSecret();
        System.out.println("MCP token store tests passed");
    }

    private static void createsPrivateStore() throws Exception {
        Path root = Files.createTempDirectory("gridbase-mcp-tokens");
        try {
            new McpTokenStore(root);
            check(Files.isRegularFile(root.resolve("mcp.sqlite")), "Token database must exist on disk");
        } finally { remove(root); }
    }

    private static void persistsOnlySecretHashes() throws Exception {
        Path root = Files.createTempDirectory("gridbase-mcp-tokens");
        try {
            McpTokenStore store = new McpTokenStore(root);
            McpTokenStore.Grant grant = new McpTokenStore.Grant("chosen", UUID.randomUUID().toString(), true);
            McpTokenStore.Created created = store.create(new GitHubAuth.User("1001", "fixture"), "Agent", "read_only", 30, new ArrayList<>(List.of(grant)));
            String secret = created.secret();
            McpTokenStore.Token token = created.token();
            check(secret.matches("gb_mcp_[A-Za-z0-9_-]{43}"), "Secrets need 256 bits of randomness with a recognizable prefix");
            check(!created.toString().contains(secret), "Created.toString must redact its secret");
            check(!token.toString().contains(secret), "Token.toString must not disclose secrets");
            String json = token.toJson();
            check(!json.contains(secret) && !json.contains("secret_hash"), "Safe metadata must not disclose authenticators");
            McpTokenStore.Token authenticated = new McpTokenStore(root).authenticate(secret);
            check(token.equals(authenticated), "An issued token must authenticate after restart");
            try (var db = DriverManager.getConnection("jdbc:sqlite:" + root.resolve("mcp.sqlite"));
                 var sql = db.createStatement(); var rows = sql.executeQuery("SELECT secret_hash FROM tokens")) {
                check(rows.next() && rows.getString(1).matches("[0-9a-f]{64}"), "Only SHA-256 digest may be persisted");
            }
            try (var files = Files.list(root)) {
                for (Path file : files.toList()) {
                    if (Files.isRegularFile(file)) check(!new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1).contains(secret), "Bearer secret leaked to disk");
                }
            }
            check(Files.getPosixFilePermissions(root).equals(PosixFilePermissions.fromString("rwx------")), "Private token directory");
            check(Files.getPosixFilePermissions(root.resolve("mcp.sqlite")).equals(PosixFilePermissions.fromString("rw-------")), "Private token database");
        } finally { remove(root); }
    }

    private static void ownerIsolationRevocationAndExpiry() throws Exception {
        Path root = Files.createTempDirectory("gridbase-mcp-tokens");
        try {
            var now = new java.util.concurrent.atomic.AtomicLong(1_800_000_000_000L);
            McpTokenStore store = new McpTokenStore(root, now::get);
            McpTokenStore.Created created = store.create(new GitHubAuth.User("1001", "fixture"), "Agent", "read_only", 30, grants());
            McpTokenStore.Created other = store.create(new GitHubAuth.User("2002", "other"), "Other agent", "full_access", 90, grants());
            check(store.list("1001").equals(List.of(created.token())), "Owners only list their own tokens");
            store.revoke("2002", created.token().id());
            check(store.authenticate(created.secret()) != null, "Foreign owner cannot revoke token");
            store.revoke("1001", created.token().id());
            check(store.authenticate(created.secret()) == null, "Revoked tokens must fail authentication");
            List<McpTokenStore.Token> revoked = store.list("1001");
            check(revoked.get(0).revokedAt().equals(now.get()), "Revocation remains visible to owner");
            store.revoke("1001", created.token().id());
            check(store.authenticate(other.secret()) != null, "Other owners' tokens remain valid");
            now.set(other.token().expiresAt() - 1);
            check(store.authenticate(other.secret()) != null, "Token remains valid until expiry");
            now.incrementAndGet();
            check(store.authenticate(other.secret()) == null, "Expiry boundary is exclusive");
            for (String invalid : new String[]{null, "", "garbage", created.secret() + "x", " " + other.secret(), "gb_mcp_" + "x".repeat(43)}) {
                check(store.authenticate(invalid) == null, "Invalid and unknown secrets fail closed");
            }
        } finally { remove(root); }
    }

    private static void validatesIssuanceAndImmutableGrants() throws Exception {
        Path root = Files.createTempDirectory("gridbase-mcp-tokens");
        try {
            McpTokenStore store = new McpTokenStore(root);
            GitHubAuth.User user = new GitHubAuth.User("1001", "fixture");
            expectInvalid(() -> store.create(user, "", "read_only", 30, grants()));
            expectInvalid(() -> store.create(user, " ", "read_only", 30, grants()));
            expectInvalid(() -> store.create(user, "x".repeat(81), "read_only", 30, grants()));
            expectInvalid(() -> store.create(user, "Agent\nname", "read_only", 30, grants()));
            expectInvalid(() -> store.create(user, null, "read_only", 30, grants()));
            expectInvalid(() -> store.create((Actor) null, "Agent", "read_only", 30, grants()));
            expectInvalid(() -> store.create(user, "Agent", "admin", 30, grants()));
            expectInvalid(() -> store.create(user, "Agent", null, 30, grants()));
            for (int days : new int[]{-1, 0, 1, 31, 89, 366, Integer.MAX_VALUE}) {
                expectInvalid(() -> store.create(user, "Agent", "read_only", days, grants()));
            }
            expectInvalid(() -> store.create(user, "Agent", "read_only", 30, List.of()));
            expectInvalid(() -> store.create(user, "Agent", "read_only", 30, null));
            expectInvalid(() -> store.create(user, "Agent", "read_only", 30,
                    List.of(new McpTokenStore.Grant("chosen", UUID.randomUUID().toString(), false))));
            McpTokenStore.Grant grant = grants().get(0);
            expectInvalid(() -> store.create(user, "Agent", "full_access", 30, List.of(grant, grant)));
            List<McpTokenStore.Grant> tooMany = new ArrayList<>();
            for (int i = 0; i < 21; i++) tooMany.add(new McpTokenStore.Grant("c" + i, UUID.randomUUID().toString(), false));
            expectInvalid(() -> store.create(user, "Agent", "full_access", 30, tooMany));
            expectInvalid(() -> new McpTokenStore.Grant("", UUID.randomUUID().toString(), true));
            expectInvalid(() -> new McpTokenStore.Grant("../foreign", UUID.randomUUID().toString(), true));
            expectInvalid(() -> new McpTokenStore.Grant("chosen", "not-a-generation", true));
            expectInvalid(() -> new McpTokenStore.Grant("chosen", null, true));
            check(store.list(user.id()).isEmpty(), "Invalid issuance must persist nothing");
            List<McpTokenStore.Grant> selected = new ArrayList<>(List.of(grant));
            McpTokenStore.Created created = store.create(user, "Agent", "read_only", 365, selected);
            selected.clear();
            check(created.token().grants().equals(List.of(grant)), "Input mutations cannot alter issued grants");
            try { created.token().grants().clear(); throw new AssertionError("Issued grants must be immutable"); }
            catch (UnsupportedOperationException expected) { }
            check(store.authenticate(created.secret()).grants().equals(List.of(grant)), "Immutable grants survive storage");
            check(created.token().expiresAt() - created.token().createdAt() == 365L * 86_400_000L, "365-day expiry is exact");
        } finally { remove(root); }
    }

    private static void activeTokenLimitIsAtomic() throws Exception {
        Path root = Files.createTempDirectory("gridbase-mcp-tokens");
        var executor = java.util.concurrent.Executors.newFixedThreadPool(6);
        try {
            var now = new java.util.concurrent.atomic.AtomicLong(1_800_000_000_000L);
            McpTokenStore store = new McpTokenStore(root, now::get);
            GitHubAuth.User user = new GitHubAuth.User("1001", "fixture");
            List<McpTokenStore.Created> tokens = new ArrayList<>();
            for (int i = 0; i < 19; i++) tokens.add(store.create(user, "Agent " + i, "read_only", 30, grants()));
            List<McpTokenStore> contenders = new ArrayList<>();
            for (int i = 0; i < 6; i++) contenders.add(new McpTokenStore(root, now::get));
            var gate = new java.util.concurrent.CountDownLatch(1);
            var futures = new ArrayList<java.util.concurrent.Future<Boolean>>();
            for (McpTokenStore contender : contenders) futures.add(executor.submit(() -> {
                gate.await();
                try { contender.create(user, "Concurrent agent", "read_only", 30, grants()); return true; }
                catch (IllegalArgumentException limited) { return false; }
            }));
            gate.countDown();
            int admitted = 0;
            for (var future : futures) if (future.get()) admitted++;
            check(admitted == 1 && store.list(user.id()).size() == 20, "Concurrent creation cannot exceed 20 active tokens/account");
            store.create(new GitHubAuth.User("2002", "other"), "Other", "full_access", 30, grants());
            store.revoke(user.id(), tokens.get(0).token().id());
            store.create(user, "Replacement", "read_only", 90, grants());
            now.addAndGet(30L * 86_400_000L);
            store.create(user, "Expired replacement", "full_access", 365, grants());
            check(store.list(user.id()).size() == 22, "Expired and revoked records remain listed but release active capacity");
        } finally { executor.shutdownNow(); remove(root); }
    }

    private static void storageFailureIsNotAnInvalidSecret() throws Exception {
        Path root = Files.createTempDirectory("gridbase-mcp-tokens");
        try {
            McpTokenStore store = new McpTokenStore(root);
            var created = store.create(new GitHubAuth.User("1001", "fixture"), "Agent", "read_only", 30, grants());
            try (var db = DriverManager.getConnection("jdbc:sqlite:" + root.resolve("mcp.sqlite")); var sql = db.createStatement()) {
                sql.executeUpdate("PRAGMA user_version=999");
            }
            expectUnavailable(() -> store.authenticate(created.secret()));
            expectUnavailable(() -> store.list("1001"));
            expectUnavailable(() -> store.revoke("1001", created.token().id()));
            expectUnavailable(() -> store.create(new GitHubAuth.User("1001", "fixture"), "Agent", "read_only", 30, grants()));
            expectUnavailable(() -> new McpTokenStore(root));
            try (var db = DriverManager.getConnection("jdbc:sqlite:" + root.resolve("mcp.sqlite")); var sql = db.createStatement()) {
                sql.executeUpdate("PRAGMA user_version=1");
                sql.executeUpdate("DELETE FROM grants");
            }
            expectUnavailable(() -> store.authenticate(created.secret()));
            Files.delete(root.resolve("mcp.sqlite"));
            expectUnavailable(() -> store.authenticate(created.secret()));
            check(!Files.exists(root.resolve("mcp.sqlite")), "Missing storage must not be silently recreated during authentication");
            Files.writeString(root.resolve("mcp.sqlite"), "not a sqlite database");
            expectUnavailable(() -> new McpTokenStore(root));
            Files.delete(root.resolve("mcp.sqlite"));
            Path target = root.resolve("target");
            Files.writeString(target, "fixture");
            Files.createSymbolicLink(root.resolve("mcp.sqlite"), target);
            expectUnavailable(() -> new McpTokenStore(root));
        } finally { remove(root); }
    }

    private static void expectUnavailable(Runnable action) {
        try { action.run(); throw new AssertionError("Expected fail-closed storage error"); }
        catch (McpTokenStore.Unavailable expected) {
            check(expected.getCause() == null, "Database exceptions must not leak stored fields");
        }
    }

    private static void expectInvalid(Runnable action) {
        try { action.run(); throw new AssertionError("Expected input rejection"); }
        catch (IllegalArgumentException expected) { }
    }

    private static List<McpTokenStore.Grant> grants() {
        return List.of(new McpTokenStore.Grant("chosen", UUID.randomUUID().toString(), true));
    }

    private static void remove(Path root) throws Exception {
        try (var paths = Files.walk(root)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
        }
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
