package com.peentar.thriftquery;

import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

public final class LocalWorkspaceTest {
    private static final byte[] MATERIAL = new byte[32];
    static { Arrays.fill(MATERIAL, (byte) 73); }
    public static void main(String[] args) throws Exception {
        if (args.length > 0) {
            try (var workspace = LocalWorkspace.open(Path.of(args[0]), new CredentialKey(MATERIAL))) {
                System.out.println("ACQUIRED " + workspace.actor().provider());
            } catch (java.io.IOException expected) { System.out.println("REFUSED"); System.exit(23); }
            return;
        }
        Path root = Files.createTempDirectory("gridbase-local-空 間");
        try {
            PrivateFiles.createDirectory(root); // Tighten the owned fixture before creating children on Windows.
            byte[] original = MATERIAL.clone(); CredentialKey key = new CredentialKey(original); original[0]++;
            check(Arrays.equals(key.secretKey().getEncoded(), MATERIAL), "key defensive input copy");
            byte[] exported = key.secretKey().getEncoded(); exported[0]++;
            check(Arrays.equals(key.secretKey().getEncoded(), MATERIAL), "key defensive output copy");
            check(key.toString().equals("CredentialKey[REDACTED]"), "key toString redacted");
            for (byte[] invalid : new byte[][] {null, new byte[0], new byte[31], new byte[33]}) {
                try { new CredentialKey(invalid); throw new AssertionError("invalid key accepted"); } catch (IllegalArgumentException expected) { }
            }
            Path data = root.resolve("local data"); Actor actor;
            Object lockIdentity;
            try (var workspace = LocalWorkspace.open(data, key)) {
                actor = workspace.actor();
                check(actor.provider().equals("local") && actor.login().equals("Local"), "local stable actor");
                check(workspace.dataDir().equals(data) && workspace.key() == key, "workspace interfaces");
                check(!Files.exists(data.resolve("credentials.key")), "never writes raw key");
                byte[] emptyWrong = MATERIAL.clone(); emptyWrong[2]++;
                fail(() -> LocalWorkspace.validate(data, new CredentialKey(emptyWrong)));
                lockIdentity = Files.readAttributes(data.resolve(".gridbase-local.lock"), java.nio.file.attribute.BasicFileAttributes.class).fileKey();
                fail(() -> LocalWorkspace.open(data, key));
                fail(() -> LocalWorkspace.open(data, key));
                check(child(data) == 23, "actual second JVM refused while first holds lock");
                check(Files.readString(data.resolve("local-workspace.json")).length() <= 8192, "manifest bounded");
                ConnectionSettings settings = ConnectionSettings.fromJson("{\"type\":\"postgresql\",\"name\":\"Offline\",\"host\":\"fixture.invalid\",\"database\":\"fixture\",\"username\":\"fixture\",\"password\":\"offline-fixture-secret\"}");
                var store = new ConnectionStore(data, actor, key); store.save("test", settings);
                check(new ConnectionStore(data, actor, key).load().get("test").profile().password().equals("offline-fixture-secret"), "injected key round trips real encrypted SQLite");
                byte[] wrong = MATERIAL.clone(); wrong[1]++;
                storeFailure(() -> new ConnectionStore(data, actor, new CredentialKey(wrong)));
                storeFailure(() -> new ConnectionStore(data, Actor.local(UUID.randomUUID().toString(), "Local"), key));
                check(!new String(Files.readAllBytes(data.resolve("gridbase.sqlite")), java.nio.charset.StandardCharsets.ISO_8859_1).contains("offline-fixture-secret"), "no plaintext persisted");
                check(!Files.exists(data.resolve("credentials.key")), "injected stores never create raw key files");
                var config = AppConfig.local(root.resolve("resources"), data, root.resolve("temp"), "desktop");
                var registries = new ConnectionWorkspaces(config, workspace);
                check(registries.forOwner(actor).details("test").profile().password().equals("offline-fixture-secret"), "local workspaces inject the engine-owned key");
                try { registries.forOwner(Actor.github("1001", "fixture")); throw new AssertionError("foreign local workspace actor accepted"); } catch (IllegalArgumentException expected) { }
                try { new ConnectionWorkspaces(config); throw new AssertionError("local config fell back to server key loading"); } catch (IllegalArgumentException expected) { }
                storeFailure(() -> new ConnectionStore(data, actor));
                var audit = new AuditStore(data);
                var event = new AuditStore.Event(actor, "connection.list", "desktop"); audit.begin(event);
                new McpTokenStore(data).create(actor, "Fixture", "read_only", 30, List.of(new McpTokenStore.Grant("test", UUID.randomUUID().toString(), true)));
            }
            check(Files.exists(data.resolve(".gridbase-local.lock")), "lock file retained on close");
            check(Objects.equals(lockIdentity, Files.readAttributes(data.resolve(".gridbase-local.lock"), java.nio.file.attribute.BasicFileAttributes.class).fileKey()), "same lock inode retained");
            check(child(data) == 0, "actual second JVM opens after close");
            var reopened = LocalWorkspace.open(data, key);
            check(reopened.actor().equals(actor), "restart restores identical local actor");
            check(new ConnectionStore(data, actor, key).load().get("test").profile().password().equals("offline-fixture-secret"), "connection data survives workspace restart");
            storeFailure(() -> new ConnectionStore(data, actor, null));
            check(new AuditStore(data).list(actor.ownerKey(), false, Map.of()).events().size() == 1, "audit survives restart");
            check(new McpTokenStore(data).list(actor.ownerKey()).size() == 1, "MCP metadata survives restart");
            reopened.close(); reopened.close();
            byte[] different = MATERIAL.clone(); different[0]++;
            fail(() -> LocalWorkspace.open(data, null));
            fail(() -> LocalWorkspace.open(data, new CredentialKey(different)));
            try (var recovered = LocalWorkspace.open(data, key)) { check(recovered.actor().equals(actor), "failed wrong-key open releases acquired lock"); }
            Path manifest = data.resolve("local-workspace.json"); String valid = Files.readString(manifest);
            if (Files.getFileStore(root).supportsFileAttributeView("posix")) {
                Path target = root.resolve("manifest-target"); Files.writeString(target, valid);
                Files.delete(manifest); Files.createSymbolicLink(manifest, target);
                fail(() -> LocalWorkspace.open(data, key));
                Files.delete(manifest); Files.writeString(manifest, valid);
                Path database = data.resolve("gridbase.sqlite"), saved = data.resolve("saved-fixture.sqlite");
                Files.move(database, saved); Files.createSymbolicLink(database, saved);
                fail(() -> LocalWorkspace.open(data, key));
                Files.delete(database); Files.move(saved, database);
            }
            for (String corrupt : List.of(valid.replace(actor.ownerKey(), "local:" + UUID.randomUUID()), valid.replace("Local", "Other"), valid.replace("\"schema\":1", "\"schema\":2"), valid.replaceFirst("\\{", "{\"extra\":true,"), valid.replaceFirst("\\{", "{\"schema\":1,"), " ".repeat(8193), "not json")) {
                Files.writeString(manifest, corrupt); fail(() -> LocalWorkspace.open(data, key));
            }
            Files.writeString(manifest, valid);
            try (var recovered = LocalWorkspace.open(data, key)) { check(recovered.actor().equals(actor), "tamper attempts do not replace actor"); }
            // Even a manifest deliberately re-authenticated with a different fixture key
            // cannot decrypt SQLite ciphertext produced by the original key.
            var changedKey = new CredentialKey(different);
            var object = StrictJson.object(valid); byte[] nonce = new byte[12]; new java.security.SecureRandom().nextBytes(nonce);
            var cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, changedKey.secretKey(), new javax.crypto.spec.GCMParameterSpec(128, nonce));
            cipher.updateAAD(("GridBase local workspace\0schema1\0" + actor.ownerKey() + "\0Local").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            object.addProperty("nonce", Base64.getUrlEncoder().withoutPadding().encodeToString(nonce));
            object.addProperty("proof", Base64.getUrlEncoder().withoutPadding().encodeToString(cipher.doFinal(new byte[0])));
            Files.writeString(manifest, object.toString());
            var wrongStore = new ConnectionStore(data, actor, changedKey);
            storeFailure(wrongStore::load);
            Files.writeString(manifest, valid);
            Files.delete(manifest); fail(() -> LocalWorkspace.open(data, key));
            for (String artifact : List.of("gridbase.sqlite", "audit.sqlite", "mcp.sqlite", "credentials.key", "gridbase.sqlite-wal")) {
                Path existing = root.resolve("existing-" + artifact); Files.createDirectory(existing); Files.writeString(existing.resolve(artifact), "fixture");
                fail(() -> LocalWorkspace.open(existing, key));
                check(!Files.exists(existing.resolve("local-workspace.json")), "never adopts existing application files");
            }
            caseAliasedArtifacts(root, key);
            System.out.println("LocalWorkspace: defensive key, integrity, tamper/bounds, persistence and real JVM lock lifecycle passed");
        } finally { PrivateFilesTest.remove(root); }
    }
    private static int child(Path data) throws Exception {
        Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-ea", "-cp", System.getProperty("java.class.path"), LocalWorkspaceTest.class.getName(), data.toString()).redirectErrorStream(true).start();
        if (!process.waitFor(20, TimeUnit.SECONDS)) { process.destroyForcibly(); throw new AssertionError("child lock probe timed out"); }
        String text = new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        check(text.contains("ACQUIRED local") || text.contains("REFUSED"), "child completed real lock probe: " + text);
        return process.exitValue();
    }
    private static void caseAliasedArtifacts(Path root, CredentialKey key) throws Exception {
        int fixture = 0;
        for (String artifact : List.of("GRIDBASE.SQLITE", "Audit.Sqlite", "McP.sQlItE", "CREDENTIALS.KEY", "Credentials.Key",
                "GRIDBASE.SQLITE-WAL", "Audit.Sqlite-Shm", "mCp.SqLiTe-JoUrNaL", "GRIDBASE.SQLITE-ORPHAN")) {
            Path data = root.resolve("case-artifact-" + fixture++); PrivateFiles.createDirectory(data);
            Path existing = data.resolve(artifact); Files.writeString(existing, "case artifact fixture");
            try { fail(() -> LocalWorkspace.open(data, key)); }
            finally {
                check(!Files.exists(data.resolve("local-workspace.json"), LinkOption.NOFOLLOW_LINKS), "case-aliased artifact must refuse without manifest creation: " + artifact);
                check(Files.readString(existing).equals("case artifact fixture"), "existing case-aliased artifact untouched");
                try (var paths = Files.list(data)) {
                    check(paths.map(p -> p.getFileName().toString()).allMatch(name -> name.equals(artifact) || name.equals(".gridbase-local.lock")), "no artifact rename or adoption");
                }
            }
        }
        System.out.println("LocalWorkspace case-alias refusal: DB/key/WAL/SHM/journal fixtures preserved without manifest creation");
        if (System.getProperty("os.name").startsWith("Windows")) System.out.println("Windows native case-alias fixtures completed");
        else System.out.println("SKIP Windows native case-alias semantics: conservative POSIX fixtures only");
    }
    interface IOAction { void run() throws Exception; }
    static void storeFailure(IOAction action) throws Exception { try { action.run(); throw new AssertionError("Unsafe injected store accepted"); } catch (ConnectionStore.StoreException expected) { } }
    static void fail(IOAction action) throws Exception { try { action.run(); throw new AssertionError("Unsafe workspace accepted"); } catch (java.io.IOException expected) { check(!expected.getMessage().contains("73"), "safe error"); } }
    static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
