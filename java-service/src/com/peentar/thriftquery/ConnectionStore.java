package com.peentar.thriftquery;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.sql.Connection;
import java.sql.DriverManager;
import java.util.LinkedHashMap;
import java.util.Map;

/** Encrypted SQLite profiles. Keep the database and its key together when backing up. */
public final class ConnectionStore {
    private static final SecureRandom RANDOM = new SecureRandom();
    private final Path database;
    private final SecretKeySpec key;
    private final String ownerId;

    public ConnectionStore(Path directory, String ownerId) {
        this.ownerId = GitHubAuth.validId(ownerId);
        synchronized (ConnectionStore.class) {
            database = directory.toAbsolutePath().normalize().resolve("gridbase.sqlite");
            Path keyFile = database.resolveSibling("credentials.key");
            try {
                Class.forName("org.sqlite.JDBC");
                Files.createDirectories(database.getParent());
                restrict(database.getParent(), "rwx------");
                if (!Files.exists(keyFile)) {
                    if (Files.exists(database)) throw new StoreException();
                    byte[] generated = new byte[32];
                    RANDOM.nextBytes(generated);
                    createPrivateFile(keyFile);
                    Files.write(keyFile, generated);
                }
                restrict(keyFile, "rw-------");
                byte[] bytes = Files.readAllBytes(keyFile);
                if (bytes.length != 32) throw new StoreException();
                key = new SecretKeySpec(bytes, "AES");
                if (!Files.exists(database)) createPrivateFile(database);
                restrict(database, "rw-------");
                try (Connection connection = open(); var statement = connection.createStatement()) {
                    try (var version = statement.executeQuery("PRAGMA user_version")) {
                        if (version.next() && version.getInt(1) > 2) throw new StoreException();
                    }
                    statement.executeUpdate("CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY NOT NULL, settings BLOB NOT NULL)");
                    boolean hasOwner = false;
                    try (var columns = statement.executeQuery("PRAGMA table_info(connections)")) {
                        while (columns.next()) if (columns.getString("name").equals("owner_id")) hasOwner = true;
                    }
                    if (!hasOwner) statement.executeUpdate("ALTER TABLE connections ADD COLUMN owner_id TEXT");
                    statement.executeUpdate("CREATE INDEX IF NOT EXISTS connections_owner ON connections(owner_id)");
                    statement.executeUpdate("PRAGMA user_version=2");
                }
            } catch (Exception error) { throw new StoreException(); }
        }
    }

    public synchronized Map<String, ConnectionSettings> load() {
        Map<String, ConnectionSettings> settings = new LinkedHashMap<>();
        try (Connection connection = open(); var statement = connection.prepareStatement("SELECT id, settings FROM connections WHERE owner_id=? ORDER BY rowid")) {
            statement.setString(1, ownerId);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    String id = rows.getString(1);
                    if (!id.matches("[a-zA-Z0-9_-]{1,100}")) throw new StoreException();
                    settings.put(id, ConnectionSettings.fromJson(decrypt(aad(id), rows.getBytes(2))));
                }
            }
            return settings;
        } catch (Exception error) { throw new StoreException(); }
    }

    public synchronized void save(String id, ConnectionSettings settings) {
        try (Connection connection = open(); var statement = connection.prepareStatement(
                "INSERT INTO connections (id, settings, owner_id) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings WHERE connections.owner_id=excluded.owner_id")) {
            statement.setString(1, id);
            statement.setBytes(2, encrypt(aad(id), settings.toJson()));
            statement.setString(3, ownerId);
            if (statement.executeUpdate() != 1) throw new ConnectionRegistry.UnknownConnectionException();
        } catch (ConnectionRegistry.UnknownConnectionException foreign) { throw foreign; } catch (Exception error) { throw new StoreException(); }
    }

    public synchronized void delete(String id) {
        try (Connection connection = open(); var statement = connection.prepareStatement("DELETE FROM connections WHERE id=? AND owner_id=?")) {
            statement.setString(1, id);
            statement.setString(2, ownerId);
            statement.executeUpdate();
        } catch (Exception error) { throw new StoreException(); }
    }

    public boolean canWrite(String id) {
        try (Connection connection = open(); var statement = connection.prepareStatement("SELECT owner_id FROM connections WHERE id=?")) {
            statement.setString(1, id);
            try (var rows = statement.executeQuery()) { return !rows.next() || ownerId.equals(rows.getString(1)); }
        } catch (Exception error) { throw new StoreException(); }
    }

    /** Trusted startup migration only. Old ciphertext uses connection-ID AAD. */
    public static void migrateLegacy(Path directory, String targetOwner) {
        ConnectionStore store = new ConnectionStore(directory, targetOwner);
        synchronized (ConnectionStore.class) {
            try (Connection connection = store.open()) {
                connection.setAutoCommit(false);
                try {
                    Map<String, byte[]> migrated = new LinkedHashMap<>();
                    try (var sql = connection.createStatement(); var rows = sql.executeQuery("SELECT id, settings FROM connections WHERE owner_id IS NULL")) {
                        while (rows.next()) {
                            String id = rows.getString(1);
                            if (!id.matches("[a-zA-Z0-9_-]{1,100}")) throw new StoreException();
                            String json = store.decrypt(id, rows.getBytes(2));
                            ConnectionSettings.fromJson(json); // Reject corrupt profiles before committing any assignment.
                            migrated.put(id, store.encrypt(store.aad(id), json));
                        }
                    }
                    try (var update = connection.prepareStatement("UPDATE connections SET owner_id=?, settings=? WHERE id=? AND owner_id IS NULL")) {
                        for (var entry : migrated.entrySet()) {
                            update.setString(1, store.ownerId); update.setBytes(2, entry.getValue()); update.setString(3, entry.getKey()); update.executeUpdate();
                        }
                    }
                    connection.commit();
                } catch (Exception error) { connection.rollback(); throw error; }
            } catch (Exception error) { throw new StoreException(); }
        }
    }

    private String aad(String id) { return ownerId + "\0" + id; }

    private Connection open() throws Exception {
        Connection connection = DriverManager.getConnection("jdbc:sqlite:" + database);
        try (var statement = connection.createStatement()) {
            statement.execute("PRAGMA busy_timeout=5000");
        } catch (Exception error) { connection.close(); throw error; }
        return connection;
    }

    private byte[] encrypt(String id, String value) throws Exception {
        byte[] nonce = new byte[12]; RANDOM.nextBytes(nonce);
        Cipher cipher = cipher(Cipher.ENCRYPT_MODE, id, nonce);
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return ByteBuffer.allocate(nonce.length + ciphertext.length).put(nonce).put(ciphertext).array();
    }

    private String decrypt(String id, byte[] value) throws Exception {
        if (value.length < 28) throw new StoreException();
        ByteBuffer buffer = ByteBuffer.wrap(value);
        byte[] nonce = new byte[12]; buffer.get(nonce);
        byte[] ciphertext = new byte[buffer.remaining()]; buffer.get(ciphertext);
        return new String(cipher(Cipher.DECRYPT_MODE, id, nonce).doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    private Cipher cipher(int mode, String id, byte[] nonce) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, key, new GCMParameterSpec(128, nonce));
        cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8));
        return cipher;
    }

    private static void createPrivateFile(Path path) throws Exception {
        if (path.getFileSystem().supportedFileAttributeViews().contains("posix")) {
            Files.createFile(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        } else Files.createFile(path);
    }

    private static void restrict(Path path, String permissions) throws Exception {
        if (path.getFileSystem().supportedFileAttributeViews().contains("posix")) {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(permissions));
        }
    }

    public static final class StoreException extends RuntimeException {
        StoreException() { super("Penyimpanan konfigurasi tidak tersedia. Periksa volume data dan credentials.key."); }
    }
}
