package com.peentar.thriftquery;

import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.function.LongSupplier;

/** Private, opaque MCP credentials. No bearer secret is persisted or logged. */
final class McpTokenStore {
    private static final SecureRandom RANDOM = new SecureRandom();
    private final Path database;
    private final LongSupplier clock;

    McpTokenStore(Path directory) {
        this(directory, System::currentTimeMillis);
    }

    McpTokenStore(Path directory, LongSupplier clock) {
        this.clock = java.util.Objects.requireNonNull(clock);
        database = directory.toAbsolutePath().normalize().resolve("mcp.sqlite");
        synchronized (McpTokenStore.class) {
            try {
                Class.forName("org.sqlite.JDBC");
                Files.createDirectories(database.getParent());
                if (Files.isSymbolicLink(database.getParent()) || Files.isSymbolicLink(database)) throw new Unavailable();
                restrict(database.getParent(), "rwx------");
                if (!Files.exists(database, LinkOption.NOFOLLOW_LINKS)) {
                    Files.createFile(database, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
                }
                if (!Files.isRegularFile(database, LinkOption.NOFOLLOW_LINKS)) throw new Unavailable();
                restrict(database, "rw-------");
                try (Connection db = open(true); var sql = db.createStatement()) {
                    int version;
                    try (var rows = sql.executeQuery("PRAGMA user_version")) { version = rows.next() ? rows.getInt(1) : -1; }
                    if (version < 0 || version > 1) throw new Unavailable();
                    if (version == 0) {
                        try (var rows = sql.executeQuery("SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")) {
                            if (!rows.next() || rows.getInt(1) != 0) throw new Unavailable();
                        }
                        db.setAutoCommit(false);
                        sql.executeUpdate("CREATE TABLE tokens (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, login TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, scope TEXT NOT NULL, secret_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)");
                        sql.executeUpdate("CREATE TABLE grants (token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE, connection_id TEXT NOT NULL, generation TEXT NOT NULL, read_only INTEGER NOT NULL CHECK(read_only IN (0,1)), PRIMARY KEY(token_id,connection_id))");
                        sql.executeUpdate("CREATE INDEX tokens_owner ON tokens(owner_id,created_at DESC)");
                        sql.executeUpdate("PRAGMA user_version=1");
                        db.commit();
                    }
                    try (var rows = sql.executeQuery("SELECT id,owner_id,login,name,prefix,scope,secret_hash,created_at,expires_at,revoked_at FROM tokens LIMIT 0")) { }
                    try (var rows = sql.executeQuery("SELECT token_id,connection_id,generation,read_only FROM grants LIMIT 0")) { }
                }
            } catch (Exception failure) { throw new Unavailable(); }
        }
    }

    Created create(GitHubAuth.User user, String name, String scope, int expiresInDays, List<Grant> grants) {
        if (user == null) throw new IllegalArgumentException("Verified owner required");
        validateName(name);
        validateScope(scope);
        if (expiresInDays != 30 && expiresInDays != 90 && expiresInDays != 365) throw new IllegalArgumentException("Invalid token expiry");
        grants = validateGrants(scope, grants);
        byte[] random = new byte[32];
        RANDOM.nextBytes(random);
        String secret = "gb_mcp_" + Base64.getUrlEncoder().withoutPadding().encodeToString(random);
        long now = clock.getAsLong();
        Token token = new Token(UUID.randomUUID().toString(), user.id(), user.login(), name,
                secret.substring(0, 15), scope, grants, now, Math.addExact(now, Math.multiplyExact((long) expiresInDays, 86_400_000L)), null);
        synchronized (McpTokenStore.class) {
            try (Connection db = open()) {
                // Acquire SQLite's write lock before counting: the limit is atomic across store instances/processes.
                try (var sql = db.createStatement()) { sql.execute("BEGIN IMMEDIATE"); }
                try (var sql = db.prepareStatement("SELECT count(*) FROM tokens WHERE owner_id=? AND revoked_at IS NULL AND expires_at>?")) {
                    sql.setString(1, user.id()); sql.setLong(2, now);
                    try (var rows = sql.executeQuery()) {
                        if (!rows.next()) throw new Unavailable();
                        if (rows.getInt(1) >= 20) throw new IllegalArgumentException("Maksimal 20 token MCP aktif per akun.");
                    }
                }
                try (var sql = db.prepareStatement("INSERT INTO tokens(id,owner_id,login,name,prefix,scope,secret_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)")) {
                    sql.setString(1, token.id()); sql.setString(2, token.ownerId()); sql.setString(3, token.login());
                    sql.setString(4, token.name()); sql.setString(5, token.prefix()); sql.setString(6, token.scope());
                    sql.setString(7, digest(secret)); sql.setLong(8, token.createdAt()); sql.setLong(9, token.expiresAt());
                    sql.executeUpdate();
                }
                try (var sql = db.prepareStatement("INSERT INTO grants(token_id,connection_id,generation,read_only) VALUES(?,?,?,?)")) {
                    for (Grant grant : token.grants()) {
                        sql.setString(1, token.id()); sql.setString(2, grant.connectionId());
                        sql.setString(3, grant.generation()); sql.setInt(4, grant.readOnly() ? 1 : 0);
                        sql.executeUpdate();
                    }
                }
                try (var sql = db.createStatement()) { sql.execute("COMMIT"); }
                return new Created(token, secret);
            } catch (IllegalArgumentException invalid) { throw invalid; }
            catch (Exception failure) { throw new Unavailable(); }
        }
    }

    Token authenticate(String secret) {
        if (secret == null || !secret.matches("gb_mcp_[A-Za-z0-9_-]{43}")) return null;
        try (Connection db = open(); var sql = db.prepareStatement("SELECT * FROM tokens WHERE secret_hash=? AND revoked_at IS NULL AND expires_at>?")) {
            sql.setString(1, digest(secret)); sql.setLong(2, clock.getAsLong());
            try (var rows = sql.executeQuery()) { return rows.next() ? read(db, rows) : null; }
        } catch (Exception failure) { throw new Unavailable(); }
    }

    List<Token> list(String ownerId) {
        GitHubAuth.validId(ownerId);
        try (Connection db = open(); var sql = db.prepareStatement("SELECT * FROM tokens WHERE owner_id=? ORDER BY created_at DESC,rowid DESC")) {
            sql.setString(1, ownerId);
            List<Token> tokens = new ArrayList<>();
            try (var rows = sql.executeQuery()) { while (rows.next()) tokens.add(read(db, rows)); }
            return List.copyOf(tokens);
        } catch (Exception failure) { throw new Unavailable(); }
    }

    void revoke(String ownerId, String tokenId) {
        GitHubAuth.validId(ownerId);
        if (tokenId == null || !ConnectionSettings.validGeneration(tokenId)) throw new IllegalArgumentException("Invalid token ID");
        try (Connection db = open(); var sql = db.prepareStatement("UPDATE tokens SET revoked_at=? WHERE id=? AND owner_id=? AND revoked_at IS NULL")) {
            sql.setLong(1, clock.getAsLong()); sql.setString(2, tokenId); sql.setString(3, ownerId);
            sql.executeUpdate(); // Foreign, missing and already revoked IDs are indistinguishable no-ops.
        } catch (Exception failure) { throw new Unavailable(); }
    }

    private static Token read(Connection db, ResultSet rows) throws Exception {
        String id = rows.getString("id");
        List<Grant> grants = new ArrayList<>();
        try (var sql = db.prepareStatement("SELECT connection_id,generation,read_only FROM grants WHERE token_id=? ORDER BY rowid")) {
            sql.setString(1, id);
            try (var selected = sql.executeQuery()) {
                while (selected.next()) {
                    int readOnly = selected.getInt(3);
                    if (selected.wasNull() || readOnly != 0 && readOnly != 1) throw new Unavailable();
                    grants.add(new Grant(selected.getString(1), selected.getString(2), readOnly == 1));
                }
            }
        }
        long revokedAt = rows.getLong("revoked_at");
        Long revoked = rows.wasNull() ? null : revokedAt;
        return new Token(id, rows.getString("owner_id"), rows.getString("login"), rows.getString("name"), rows.getString("prefix"),
                rows.getString("scope"), grants, rows.getLong("created_at"), rows.getLong("expires_at"), revoked);
    }

    private static String digest(String secret) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(secret.getBytes(StandardCharsets.US_ASCII)));
    }

    record Grant(String connectionId, String generation, boolean readOnly) {
        Grant {
            if (connectionId == null || !connectionId.matches("[a-zA-Z0-9_-]{1,100}")
                    || !ConnectionSettings.validGeneration(generation)) throw new IllegalArgumentException("Invalid connection grant");
        }
        String toJson() { return "{\"connectionId\":" + JsonUtil.quote(connectionId) + ",\"generation\":" + JsonUtil.quote(generation) + ",\"readOnly\":" + readOnly + "}"; }
    }

    record Token(String id, String ownerId, String login, String name, String prefix, String scope, List<Grant> grants,
                 long createdAt, long expiresAt, Long revokedAt) {
        Token {
            if (!ConnectionSettings.validGeneration(id)) throw new IllegalArgumentException("Invalid token ID");
            new GitHubAuth.User(ownerId, login);
            validateName(name);
            validateScope(scope);
            if (prefix == null || !prefix.matches("gb_mcp_[A-Za-z0-9_-]{8}")) throw new IllegalArgumentException("Invalid safe token prefix");
            grants = validateGrants(scope, grants);
            long duration = expiresAt - createdAt;
            if (createdAt <= 0 || expiresAt <= createdAt || duration != 30L * 86_400_000L && duration != 90L * 86_400_000L && duration != 365L * 86_400_000L
                    || revokedAt != null && revokedAt < createdAt) throw new IllegalArgumentException("Invalid token timestamps");
        }
        String toJson() {
            return "{\"id\":" + JsonUtil.quote(id) + ",\"ownerId\":" + JsonUtil.quote(ownerId) + ",\"login\":" + JsonUtil.quote(login)
                    + ",\"name\":" + JsonUtil.quote(name) + ",\"prefix\":" + JsonUtil.quote(prefix) + ",\"scope\":" + JsonUtil.quote(scope)
                    + ",\"grants\":[" + grants.stream().map(Grant::toJson).collect(java.util.stream.Collectors.joining(",")) + "]"
                    + ",\"createdAt\":" + createdAt + ",\"expiresAt\":" + expiresAt + ",\"revokedAt\":" + revokedAt + "}";
        }
    }

    record Created(Token token, String secret) {
        @Override public String toString() { return "Created[token=" + token.id() + ",secret=REDACTED]"; }
    }

    private static void validateName(String name) {
        if (name == null || name.isBlank() || name.length() > 80 || name.chars().anyMatch(Character::isISOControl))
            throw new IllegalArgumentException("Token name must contain 1-80 printable characters");
    }

    private static void validateScope(String scope) {
        if (!"read_only".equals(scope) && !"full_access".equals(scope)) throw new IllegalArgumentException("Invalid token scope");
    }

    private static List<Grant> validateGrants(String scope, List<Grant> grants) {
        if (grants == null || grants.isEmpty() || grants.size() > 20) throw new IllegalArgumentException("Select 1-20 connections");
        var ids = new java.util.HashSet<String>();
        for (Grant grant : grants) {
            if (grant == null || !ids.add(grant.connectionId()) || scope.equals("read_only") && !grant.readOnly())
                throw new IllegalArgumentException("Invalid or ineligible connection grant");
        }
        return List.copyOf(grants);
    }

    private Connection open() throws Exception {
        return open(false);
    }

    private Connection open(boolean initializing) throws Exception {
        if (!Files.isRegularFile(database, LinkOption.NOFOLLOW_LINKS)) throw new Unavailable();
        restrict(database.getParent(), "rwx------");
        restrict(database, "rw-------");
        Connection db = DriverManager.getConnection("jdbc:sqlite:" + database);
        try (var sql = db.createStatement()) {
            if (!initializing) {
                try (var rows = sql.executeQuery("PRAGMA user_version")) {
                    if (!rows.next() || rows.getInt(1) != 1) throw new Unavailable();
                }
            }
            sql.execute("PRAGMA busy_timeout=5000");
            sql.execute("PRAGMA synchronous=FULL");
            sql.execute("PRAGMA foreign_keys=ON");
            sql.execute("PRAGMA secure_delete=ON");
        } catch (Exception failure) { db.close(); throw failure; }
        return db;
    }

    private static void restrict(Path path, String mode) throws Exception {
        // A non-private filesystem is not suitable for bearer credential storage.
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(mode));
    }

    static final class Unavailable extends RuntimeException {
        Unavailable() { super("Penyimpanan token MCP tidak tersedia. Periksa volume data."); }
    }
}
