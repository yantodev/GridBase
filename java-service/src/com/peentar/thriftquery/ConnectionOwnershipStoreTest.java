package com.peentar.thriftquery;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.util.Comparator;

public final class ConnectionOwnershipStoreTest {
    private static final ConnectionSettings SETTINGS = ConnectionSettings.fromJson("{\"type\":\"postgresql\",\"name\":\"Private\",\"host\":\"fixture\",\"database\":\"app\",\"username\":\"fixture\",\"password\":\"secret\"}");
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-owner-store");
        try {
            Path data = root.resolve("scoped");
            var alice = new ConnectionStore(data, "1001");
            var bob = new ConnectionStore(data, "2002");
            alice.save("private", SETTINGS);
            check(bob.load().isEmpty(), "Other owner cannot load credentials");
            check(!bob.canWrite("private"), "Foreign IDs cannot be written");
            try { bob.save("private", SETTINGS); throw new AssertionError("Foreign overwrite allowed"); }
            catch (ConnectionRegistry.UnknownConnectionException expected) { }
            bob.delete("private");
            check(alice.load().size() == 1, "Foreign deletion cannot remove owner data");
            // Moving ciphertext to another owner must fail GCM authentication.
            try (var db = DriverManager.getConnection("jdbc:sqlite:" + data.resolve("gridbase.sqlite")); var sql = db.createStatement()) {
                sql.executeUpdate("UPDATE connections SET owner_id='2002' WHERE id='private'");
            }
            failure(bob::load);
            Path legacy = root.resolve("legacy"); fixture(legacy, false);
            check(new ConnectionStore(legacy, "1001").load().isEmpty(), "Unassigned legacy data stays hidden");
            ConnectionStore.migrateLegacy(legacy, "1001");
            check(new ConnectionStore(legacy, "1001").load().size() == 2, "All legacy profiles migrated");
            check(new ConnectionStore(legacy, "2002").load().isEmpty(), "Only migration target sees legacy profiles");
            ConnectionStore.migrateLegacy(legacy, "2002");
            check(new ConnectionStore(legacy, "1001").load().size() == 2, "Repeated migration never reassigns owned rows");
            Path startup = root.resolve("startup"); fixture(startup.resolve("data"), false);
            var config = AppConfig.load(startup, java.util.Map.of("LEGACY_CONNECTION_OWNER_ID", "1001"));
            var workspaces = new ConnectionWorkspaces(config);
            check(workspaces.forOwner("1001").entries().size() == 2 && workspaces.forOwner("2002").entries().isEmpty(), "Startup consumes trusted migration config only");
            Path corrupt = root.resolve("corrupt"); fixture(corrupt, true);
            failure(() -> ConnectionStore.migrateLegacy(corrupt, "1001"));
            try (var db = DriverManager.getConnection("jdbc:sqlite:" + corrupt.resolve("gridbase.sqlite")); var sql = db.createStatement(); var rows = sql.executeQuery("SELECT count(*) FROM connections WHERE owner_id IS NOT NULL")) {
                check(rows.next() && rows.getInt(1) == 0, "Corrupt migration rolls back every assignment");
            }
            System.out.println("Connection owner store and atomic migration tests passed");
        } finally { try (var files = Files.walk(root)) { for (var file : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(file); } }
    }
    private static void fixture(Path data, boolean corrupt) throws Exception {
        Files.createDirectories(data);
        byte[] key = new byte[32]; new java.security.SecureRandom().nextBytes(key);
        Files.write(data.resolve("credentials.key"), key);
        try (var db = DriverManager.getConnection("jdbc:sqlite:" + data.resolve("gridbase.sqlite")); var sql = db.createStatement()) {
            sql.executeUpdate("CREATE TABLE connections (id TEXT PRIMARY KEY NOT NULL, settings BLOB NOT NULL)");
            sql.executeUpdate("PRAGMA user_version=1");
            for (String id : java.util.List.of("old-a", "old-b")) {
                byte[] nonce = new byte[12]; new java.security.SecureRandom().nextBytes(nonce);
                var cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
                cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8));
                byte[] encrypted = cipher.doFinal(SETTINGS.toJson().getBytes(StandardCharsets.UTF_8));
                if (corrupt && id.equals("old-b")) encrypted[0] ^= 1;
                try (var insert = db.prepareStatement("INSERT INTO connections VALUES (?,?)")) {
                    insert.setString(1, id); insert.setBytes(2, ByteBuffer.allocate(12 + encrypted.length).put(nonce).put(encrypted).array()); insert.executeUpdate();
                }
            }
        }
    }
    private static void failure(Runnable action) { try { action.run(); throw new AssertionError("Expected storage failure"); } catch (ConnectionStore.StoreException expected) { } }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
