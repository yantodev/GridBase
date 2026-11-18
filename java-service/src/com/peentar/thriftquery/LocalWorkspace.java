package com.peentar.thriftquery;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.*;

/** One private offline profile; the owning engine must keep this object open for its lifetime. */
final class LocalWorkspace implements AutoCloseable {
    private static final String MANIFEST = "local-workspace.json";
    private static final int MAX_MANIFEST = 8192;
    private static final SecureRandom RANDOM = new SecureRandom();
    // POSIX locks are process-associated: closing a second channel to this inode can
    // release the first channel's lock. Reject same-JVM contenders before opening it.
    private static final Set<Path> OPEN = new HashSet<>();
    private final Path dataDir;
    private final CredentialKey key;
    private final Actor actor;
    private final FileChannel channel;
    private final FileLock lock;
    private boolean closed;

    private LocalWorkspace(Path dataDir, CredentialKey key, Actor actor, FileChannel channel, FileLock lock) {
        this.dataDir = dataDir; this.key = key; this.actor = actor; this.channel = channel; this.lock = lock;
    }
    static LocalWorkspace open(Path supplied, CredentialKey key) throws IOException {
        FileChannel channel = null; FileLock lock = null;
        Path reserved = null;
        try {
            if (key == null || supplied == null || !supplied.isAbsolute()) throw unavailable();
            Path dataDir = supplied.normalize();
            synchronized (OPEN) {
                if (!OPEN.add(dataDir)) throw locked();
                reserved = dataDir;
            }
            PrivateFiles.createDirectory(dataDir);
            Path lockPath = dataDir.resolve(".gridbase-local.lock");
            PrivateFiles.createFile(lockPath);
            channel = FileChannel.open(lockPath, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
            lock = channel.tryLock();
            if (lock == null) throw locked();
            Path manifest = dataDir.resolve(MANIFEST);
            Actor actor;
            if (Files.exists(manifest, LinkOption.NOFOLLOW_LINKS)) actor = validate(dataDir, key);
            else {
                // Never infer ownership from an old server database, raw key, or orphaned journal.
                // Ask the provider about canonical names first (including native case aliases).
                for (String name : List.of("credentials.key", "gridbase.sqlite", "audit.sqlite", "mcp.sqlite")) {
                    if (Files.exists(dataDir.resolve(name), LinkOption.NOFOLLOW_LINKS)) throw unavailable();
                    for (String suffix : List.of("-wal", "-shm", "-journal"))
                        if (Files.exists(dataDir.resolve(name + suffix), LinkOption.NOFOLLOW_LINKS)) throw unavailable();
                }
                try (var entries = Files.list(dataDir)) {
                    if (entries.anyMatch(p -> applicationArtifact(p.getFileName().toString()))) throw unavailable();
                }
                actor = Actor.local(UUID.randomUUID().toString(), "Local");
                createManifest(manifest, actor, key);
            }
            return new LocalWorkspace(dataDir, key, actor, channel, lock);
        } catch (java.nio.channels.OverlappingFileLockException conflict) {
            cleanup(lock, channel); unreserve(reserved); throw locked();
        } catch (Exception failure) {
            cleanup(lock, channel); unreserve(reserved);
            if (failure instanceof IOException io && io.getMessage() != null && io.getMessage().startsWith("Local workspace is already")) throw io;
            throw unavailable();
        }
    }
    Actor actor() { return actor; }
    Path dataDir() { return dataDir; }
    CredentialKey key() { return key; }
    @Override public synchronized void close() throws IOException {
        if (closed) return;
        closed = true;
        try { lock.release(); } finally {
            try { channel.close(); } finally { unreserve(dataDir); }
        }
        // Never unlink the lock: another process may hold the same inode.
    }
    private static void unreserve(Path path) { if (path != null) synchronized (OPEN) { OPEN.remove(path); } }
    private static void cleanup(FileLock lock, FileChannel channel) {
        try { if (lock != null) lock.release(); } catch (IOException ignored) { /* channel close also releases this attempt's lock */ }
        try { if (channel != null) channel.close(); } catch (IOException ignored) { }
    }
    private static boolean applicationArtifact(String name) {
        // Conservatively refuse aliases even on case-sensitive filesystems; never rename/adopt.
        name = name.toLowerCase(Locale.ROOT);
        return name.equals("credentials.key") || name.equals(MANIFEST) || name.equals("local-mcp.json") || name.startsWith(".local-mcp-") || name.matches("(?:gridbase|audit|mcp)\\.sqlite(?:-.*)?");
    }

    /** Key/actor binding for injected stores, without opening or owning another workspace lock. */
    static Actor validate(Path dataDir, CredentialKey key) throws IOException {
        try {
            if (key == null) throw unavailable();
            PrivateFiles.verify(dataDir);
            if (Files.exists(dataDir.resolve("credentials.key"), LinkOption.NOFOLLOW_LINKS)) throw unavailable();
            Path manifest = dataDir.resolve(MANIFEST); PrivateFiles.createFileExisting(manifest);
            ByteBuffer buffer = ByteBuffer.allocate(MAX_MANIFEST + 1);
            try (var channel = FileChannel.open(manifest, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
                while (buffer.hasRemaining() && channel.read(buffer) != -1) { }
            }
            if (buffer.position() > MAX_MANIFEST) throw unavailable();
            buffer.flip();
            var object = StrictJson.object(StandardCharsets.UTF_8.newDecoder().decode(buffer).toString());
            if (!object.keySet().equals(Set.of("schema", "owner", "label", "nonce", "proof")) || !object.get("schema").toString().equals("1")) throw unavailable();
            String owner = StrictJson.string(object, "owner", 42), label = StrictJson.string(object, "label", 80);
            Actor actor = Actor.fromOwnerKey(owner, label);
            if (!actor.provider().equals("local") || !label.equals("Local")) throw unavailable();
            byte[] nonce = decode(StrictJson.string(object, "nonce", 16), 12);
            byte[] proof = decode(StrictJson.string(object, "proof", 22), 16);
            Cipher cipher = manifestCipher(Cipher.DECRYPT_MODE, key, actor, nonce);
            if (cipher.doFinal(proof).length != 0) throw unavailable();
            for (String name : List.of("gridbase.sqlite", "audit.sqlite", "mcp.sqlite")) PrivateFiles.databasePaths(dataDir.resolve(name));
            return actor;
        } catch (Exception failure) { throw unavailable(); }
    }
    private static byte[] decode(String value, int size) throws IOException {
        try {
            byte[] result = Base64.getUrlDecoder().decode(value);
            if (result.length != size || !encode(result).equals(value)) throw unavailable();
            return result;
        } catch (IllegalArgumentException invalid) { throw unavailable(); }
    }
    private static String encode(byte[] bytes) { return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    private static Cipher manifestCipher(int mode, CredentialKey key, Actor actor, byte[] nonce) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, key.secretKey(), new GCMParameterSpec(128, nonce));
        cipher.updateAAD(("GridBase local workspace\0schema1\0" + actor.ownerKey() + "\0" + actor.login()).getBytes(StandardCharsets.UTF_8));
        return cipher;
    }
    private static void createManifest(Path manifest, Actor actor, CredentialKey key) throws Exception {
        byte[] nonce = new byte[12]; RANDOM.nextBytes(nonce);
        String text = "{\"schema\":1,\"owner\":" + JsonUtil.quote(actor.ownerKey()) + ",\"label\":\"Local\",\"nonce\":" + JsonUtil.quote(encode(nonce))
                + ",\"proof\":" + JsonUtil.quote(encode(manifestCipher(Cipher.ENCRYPT_MODE, key, actor, nonce).doFinal(new byte[0]))) + "}";
        Path staging = manifest.resolveSibling(".local-workspace-" + UUID.randomUUID() + ".tmp");
        try {
            PrivateFiles.createFile(staging);
            try (var channel = FileChannel.open(staging, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                ByteBuffer bytes = StandardCharsets.UTF_8.encode(text);
                while (bytes.hasRemaining()) channel.write(bytes);
                channel.force(true);
            }
            if (Files.exists(manifest, LinkOption.NOFOLLOW_LINKS)) throw unavailable();
            Files.move(staging, manifest, StandardCopyOption.ATOMIC_MOVE);
            PrivateFiles.verify(manifest);
        } finally { Files.deleteIfExists(staging); }
    }
    record McpSettings(boolean enabled, int port) { }

    /** Separate owner/key-authenticated settings; identity manifest schema is immutable. */
    synchronized McpSettings mcpSettings() throws IOException {
        try {
            if (closed) throw settingsUnavailable();
            // The open workspace already authenticated its immutable owner/key. Revalidating
            // all SQLite sidecars here would couple settings to concurrent journal lifetimes.
            PrivateFiles.verify(dataDir);
            Path file = dataDir.resolve("local-mcp.json");
            PrivateFiles.checkPath(file);
            try { Files.readAttributes(file, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS); }
            catch (NoSuchFileException absent) {
                if (absent.getFile() == null || !Path.of(absent.getFile()).toAbsolutePath().normalize().equals(file)) throw absent;
                PrivateFiles.verify(dataDir);
                return new McpSettings(false, 4174);
            }
            PrivateFiles.verify(file); // Never repair an unsafe settings path or its permissions.
            ByteBuffer bytes = ByteBuffer.allocate(MAX_MANIFEST + 1);
            try (var input = FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
                while (bytes.hasRemaining() && input.read(bytes) != -1) { }
            }
            if (bytes.position() > MAX_MANIFEST) throw settingsUnavailable();
            bytes.flip();
            var object = StrictJson.object(StandardCharsets.UTF_8.newDecoder().decode(bytes).toString());
            if (!object.keySet().equals(Set.of("schema", "owner", "enabled", "port", "nonce", "proof"))
                    || !object.get("schema").toString().equals("1")
                    || !StrictJson.string(object, "owner", 42).equals(actor.ownerKey())
                    || !object.get("enabled").isJsonPrimitive() || !object.get("enabled").getAsJsonPrimitive().isBoolean()
                    || !object.get("port").isJsonPrimitive() || !object.get("port").getAsJsonPrimitive().isNumber()
                    || !object.get("port").toString().matches("[1-9][0-9]{0,4}")) throw settingsUnavailable();
            McpSettings settings = new McpSettings(object.get("enabled").getAsBoolean(), object.get("port").getAsInt());
            validatePort(settings.port());
            byte[] nonce = decode(StrictJson.string(object, "nonce", 16), 12);
            byte[] proof = decode(StrictJson.string(object, "proof", 22), 16);
            if (settingsCipher(Cipher.DECRYPT_MODE, settings, nonce).doFinal(proof).length != 0) throw settingsUnavailable();
            return settings;
        } catch (Exception invalid) { throw settingsUnavailable(); }
    }
    synchronized void saveMcpSettings(boolean enabled, int port) throws IOException {
        validatePort(port);
        mcpSettings(); // Refuse to overwrite corrupt/unsafe existing settings, including wrong-owner copies.
        Path file = dataDir.resolve("local-mcp.json");
        Path staging = dataDir.resolve(".local-mcp-" + UUID.randomUUID() + ".tmp");
        McpSettings settings = new McpSettings(enabled, port);
        try {
            byte[] nonce = new byte[12]; RANDOM.nextBytes(nonce);
            String text = "{\"schema\":1,\"owner\":" + JsonUtil.quote(actor.ownerKey()) + ",\"enabled\":" + enabled + ",\"port\":" + port
                    + ",\"nonce\":" + JsonUtil.quote(encode(nonce)) + ",\"proof\":"
                    + JsonUtil.quote(encode(settingsCipher(Cipher.ENCRYPT_MODE, settings, nonce).doFinal(new byte[0]))) + "}";
            try (var output = PrivateFiles.createNewFile(staging)) {
                ByteBuffer bytes = StandardCharsets.UTF_8.encode(text);
                while (bytes.hasRemaining()) output.write(bytes);
                output.force(true);
            }
            PrivateFiles.verify(dataDir); PrivateFiles.checkPath(file);
            if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) PrivateFiles.verify(file);
            Files.move(staging, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            if (!mcpSettings().equals(settings)) throw settingsUnavailable();
        } catch (Exception failure) { throw settingsUnavailable(); }
        finally { Files.deleteIfExists(staging); }
    }
    private Cipher settingsCipher(int mode, McpSettings settings, byte[] nonce) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, key.secretKey(), new GCMParameterSpec(128, nonce));
        cipher.updateAAD(("GridBase local MCP settings\0schema1\0" + actor.ownerKey() + "\0" + settings.enabled() + "\0" + settings.port()).getBytes(StandardCharsets.UTF_8));
        return cipher;
    }
    static void validatePort(int port) {
        if (port < 1 || port > 65535) throw new IllegalArgumentException("MCP port must be between 1 and 65535.");
    }
    private static IOException settingsUnavailable() { return new IOException("Local MCP settings cannot be authenticated safely. Check the intact local settings, owner, supplied key and private permissions; do not replace existing data or keys."); }

    private static IOException locked() { return new IOException("Local workspace is already open. Close the other GridBase process before trying again."); }
    private static IOException unavailable() { return new IOException("Local workspace cannot be opened safely. Check private permissions, the supplied credential key and the intact local manifest; do not replace existing data or keys."); }
}
