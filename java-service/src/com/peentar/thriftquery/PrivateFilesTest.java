package com.peentar.thriftquery;

import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.*;

public final class PrivateFilesTest {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-private-空 間");
        try {
            PrivateFiles.createDirectory(root); // Existing owned fixture root may be tightened safely.
            Path directory = root.resolve("private data");
            PrivateFiles.createDirectory(directory);
            Path file = directory.resolve("private.key");
            PrivateFiles.createFile(file);
            PrivateFiles.verify(directory); PrivateFiles.verify(file);
            Path exclusive = directory.resolve("exclusive.fixture");
            try (var channel = PrivateFiles.createNewFile(exclusive)) {
                channel.write(java.nio.ByteBuffer.wrap(new byte[] {7, 8, 9}));
            }
            unsafe(() -> { try (var ignored = PrivateFiles.createNewFile(exclusive)) { throw new AssertionError("exclusive creation accepted existing file"); } });
            check(Arrays.equals(Files.readAllBytes(exclusive), new byte[] {7, 8, 9}), "exclusive failure preserves established bytes");
            PrivateFiles.verify(exclusive);
            if (Files.getFileStore(root).supportsFileAttributeView("posix")) inheritancePolicy(root);
            storePaths(root);
            Path zip = root.resolve("unsupported.zip");
            try (var filesystem = FileSystems.newFileSystem(java.net.URI.create("jar:" + zip.toUri()), Map.of("create", "true"))) {
                unsafe(() -> PrivateFiles.createDirectory(filesystem.getPath("/private")));
                unsafe(() -> { try (var ignored = PrivateFiles.createNewFile(filesystem.getPath("/new-key"))) { throw new AssertionError("unsupported permissions accepted"); } });
            }
            if (Files.getFileStore(root).supportsFileAttributeView("posix")) {
                check(Files.getPosixFilePermissions(directory).equals(PosixFilePermissions.fromString("rwx------")), "directory 0700");
                check(Files.getPosixFilePermissions(file).equals(PosixFilePermissions.fromString("rw-------")), "file 0600");
                Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
                unsafe(() -> PrivateFiles.verify(file));
                PrivateFiles.createFile(file);
                check(Files.getPosixFilePermissions(file).equals(PosixFilePermissions.fromString("rw-------")), "owned file repaired");
                Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwxrwxrwx"));
                unsafe(() -> PrivateFiles.verify(directory));
                PrivateFiles.createDirectory(directory);
                Path link = root.resolve("linked"); Files.createSymbolicLink(link, directory);
                unsafe(() -> PrivateFiles.createDirectory(link));
                unsafe(() -> PrivateFiles.createFile(link.resolve("redirect")));
                Path leaf = directory.resolve("linked.key"); Files.createSymbolicLink(leaf, file);
                unsafe(() -> PrivateFiles.createFile(leaf));
                Path hard = directory.resolve("hard.key"); Files.createLink(hard, file);
                unsafe(() -> PrivateFiles.createFile(hard)); Files.delete(hard);
                String userName = System.getProperty("user.name");
                try { System.setProperty("user.name", "not-the-native-owner"); PrivateFiles.verify(file); }
                finally { System.setProperty("user.name", userName); }
                check(Files.getPosixFilePermissions(root).equals(PosixFilePermissions.fromString("rwx------")), "ancestor not changed");
                Path shared = root.resolve("shared-ancestor"); Files.createDirectory(shared);
                Files.setPosixFilePermissions(shared, PosixFilePermissions.fromString("rwxr-xr-x"));
                PrivateFiles.createDirectory(shared.resolve("managed"));
                check(Files.getPosixFilePermissions(shared).equals(PosixFilePermissions.fromString("rwxr-xr-x")), "unmanaged shared ancestor permissions preserved");
                System.out.println("PrivateFiles POSIX: 0700/0600, repair, unsafe grants and symlink ancestors/targets passed");
                System.out.println("SKIP Windows native DACL/reparse tests: current filesystem is POSIX");
            } else {
                var view = Files.getFileAttributeView(file, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
                check(view != null, "native Windows ACL required");
                UserPrincipal other = windowsFixtureTrustee(root);
                windowsCreationRefusal(directory, other);
                var broad = AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(other).setPermissions(AclEntryPermission.READ_DATA, AclEntryPermission.WRITE_DATA).build();
                var entries = new ArrayList<>(view.getAcl()); entries.add(broad); view.setAcl(entries);
                unsafe(() -> PrivateFiles.verify(file));
                PrivateFiles.createFile(file); PrivateFiles.verify(file);
                var directoryView = Files.getFileAttributeView(directory, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
                var inherited = AclEntry.newBuilder(broad).setFlags(AclEntryFlag.FILE_INHERIT, AclEntryFlag.DIRECTORY_INHERIT).build();
                var directoryEntries = new ArrayList<>(directoryView.getAcl()); directoryEntries.add(inherited); directoryView.setAcl(directoryEntries);
                Path child = directory.resolve("inherited.txt"); Files.createFile(child);
                unsafe(() -> PrivateFiles.verify(child));
                PrivateFiles.createDirectory(directory); PrivateFiles.createFile(child); PrivateFiles.verify(child);
                windowsReparse(root, directory);
                System.out.println("PrivateFiles Windows native DACL: broad grants rejected, owner-only repair passed");
                System.out.println("SKIP POSIX modes: current filesystem is Windows ACL");
            }
        } finally { remove(root); }
    }
    interface IOAction { void run() throws Exception; }
    // ACL policy logic can run on Linux; this is NOT native Windows creation evidence.
    private static void inheritancePolicy(Path root) throws Exception {
        UserPrincipal owner = Files.getOwner(root);
        var lookup = root.getFileSystem().getUserPrincipalLookupService();
        UserPrincipal other = lookup.lookupPrincipalByName("0");
        if (other.equals(owner)) other = lookup.lookupPrincipalByName("65534");
        var ownerFull = AclEntry.newBuilder().setPrincipal(owner).setType(AclEntryType.ALLOW).setPermissions(EnumSet.allOf(AclEntryPermission.class)).build();
        for (AclEntryFlag flag : List.of(AclEntryFlag.FILE_INHERIT, AclEntryFlag.DIRECTORY_INHERIT)) {
            for (AclEntryPermission permission : List.of(AclEntryPermission.READ_DATA, AclEntryPermission.WRITE_DATA)) {
                var broad = AclEntry.newBuilder().setPrincipal(other).setType(AclEntryType.ALLOW).setPermissions(permission).setFlags(flag).build();
                unsafe(() -> PrivateFiles.verifyInheritedAcl(List.of(ownerFull, broad), owner));
                PrivateFiles.verifyInheritedAcl(List.of(ownerFull, AclEntry.newBuilder(broad).setPrincipal(owner).build()), owner);
                var inheritOnly = AclEntry.newBuilder(broad).setFlags(flag, AclEntryFlag.INHERIT_ONLY).build();
                unsafe(() -> PrivateFiles.verifyInheritedAcl(List.of(ownerFull, inheritOnly), owner));
            }
        }
        var denied = AclEntry.newBuilder().setPrincipal(owner).setType(AclEntryType.DENY).setPermissions(AclEntryPermission.WRITE_DATA).setFlags(AclEntryFlag.FILE_INHERIT).build();
        unsafe(() -> PrivateFiles.verifyInheritedAcl(List.of(denied), owner));
        unsafe(() -> PrivateFiles.verifyInheritedAcl(List.of(), owner));
        PrivateFiles.verifyInheritedAcl(List.of(ownerFull), owner);
        System.out.println("Inherited ACL policy logic: both child flags, broad read/write and inherit-only rejected (not native Windows evidence)");
    }
    // Reuse an actual non-owner native trustee from the unmanaged fixture ancestor.
    // No textual SID/account-name assumptions or shell identity manipulation.
    private static UserPrincipal windowsFixtureTrustee(Path root) throws Exception {
        UserPrincipal owner = Files.getOwner(root, LinkOption.NOFOLLOW_LINKS);
        var view = Files.getFileAttributeView(root.getParent(), AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        return view.getAcl().stream().filter(e -> e.type() == AclEntryType.ALLOW && !e.principal().equals(owner))
                .map(AclEntry::principal).findFirst().orElseThrow(() -> new AssertionError("Windows fixture needs a native non-owner trustee on its scratch ancestor"));
    }
    private static void windowsCreationRefusal(Path safeDirectory, UserPrincipal other) throws Exception {
        for (AclEntryFlag flag : List.of(AclEntryFlag.FILE_INHERIT, AclEntryFlag.DIRECTORY_INHERIT)) {
            for (AclEntryPermission permission : List.of(AclEntryPermission.READ_DATA, AclEntryPermission.WRITE_DATA)) {
                Path parent = safeDirectory.resolve("unsafe-parent-" + flag + "-" + permission); PrivateFiles.createDirectory(parent);
                var view = Files.getFileAttributeView(parent, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
                var grants = new ArrayList<>(view.getAcl());
                grants.add(AclEntry.newBuilder().setPrincipal(other).setType(AclEntryType.ALLOW).setPermissions(permission).setFlags(flag).build());
                view.setAcl(grants);
                var before = List.copyOf(view.getAcl()); UserPrincipal owner = view.getOwner();
                Path childFile = parent.resolve("new-file"), childDir = parent.resolve("new-directory"), exclusive = parent.resolve("new-exclusive");
                unsafe(() -> PrivateFiles.createFile(childFile));
                unsafe(() -> PrivateFiles.createDirectory(childDir));
                unsafe(() -> { try (var ignored = PrivateFiles.createNewFile(exclusive)) { throw new AssertionError("unsafe ACL parent accepted"); } });
                check(!Files.exists(childFile, LinkOption.NOFOLLOW_LINKS) && !Files.exists(childDir, LinkOption.NOFOLLOW_LINKS)
                        && !Files.exists(exclusive, LinkOption.NOFOLLOW_LINKS), "unsafe inherited policy must refuse before any object creation");
                check(before.equals(view.getAcl()) && owner.equals(view.getOwner()), "unsafe shared parent policy/owner unchanged");
                PrivateFiles.createDirectory(parent); // Restore only the owned managed fixture for cleanup.
            }
        }
        System.out.println("Windows native inherited-policy refusal: file/directory read/write flags, no creation and unchanged parents verified");
    }
    private static String windowsCommand(String script) throws Exception {
        String encoded = Base64.getEncoder().encodeToString(script.getBytes(java.nio.charset.StandardCharsets.UTF_16LE));
        Process process = new ProcessBuilder("powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded).redirectErrorStream(true).start();
        if (!process.waitFor(20, java.util.concurrent.TimeUnit.SECONDS)) { process.destroyForcibly(); throw new AssertionError("Windows fixture timed out"); }
        String output = new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        check(process.exitValue() == 0, "Windows native fixture failed: " + output);
        return output;
    }
    private static void windowsReparse(Path root, Path target) throws Exception {
        Path junction = root.resolve("junction");
        String path = junction.toString().replace("'", "''"), destination = target.toString().replace("'", "''");
        windowsCommand("$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path '" + path + "' -Target '" + destination + "' | Out-Null");
        try { unsafe(() -> PrivateFiles.createDirectory(junction)); unsafe(() -> PrivateFiles.createFile(junction.resolve("redirect"))); }
        finally { Files.delete(junction); }
    }
    private static void storePaths(Path root) throws Exception {
        int sequence = 0;
        for (String store : List.of("connection", "audit", "mcp")) {
            String name = store.equals("connection") ? "gridbase.sqlite" : store.equals("audit") ? "audit.sqlite" : "mcp.sqlite";
            Path data = root.resolve("stores-" + sequence++); Files.createDirectory(data);
            Path target = root.resolve("untouched-" + sequence); Files.writeString(target, "fixture sentinel");
            if (Files.getFileStore(root).supportsFileAttributeView("posix")) {
                Files.createSymbolicLink(data.resolve(name), target);
                storeUnsafe(() -> construct(store, data));
                check(Files.readString(target).equals("fixture sentinel"), "linked database untouched");
                Files.delete(data.resolve(name));
                Files.createSymbolicLink(data.resolve(name + "-wal"), target);
                storeUnsafe(() -> construct(store, data));
                check(Files.readString(target).equals("fixture sentinel"), "linked WAL untouched");
                if (store.equals("connection")) check(!Files.exists(data.resolve("credentials.key")), "permission error must not generate key material");
                Files.delete(data.resolve(name + "-wal"));
                Path alias = root.resolve("alias-" + sequence); Files.createSymbolicLink(alias, data);
                storeUnsafe(() -> construct(store, alias));
            }
            construct(store, data);
            PrivateFiles.verify(data); PrivateFiles.verify(data.resolve(name));
            if (store.equals("audit")) {
                try (var db = java.sql.DriverManager.getConnection("jdbc:sqlite:" + data.resolve(name)); var sql = db.createStatement()) {
                    sql.execute("PRAGMA journal_mode=WAL");
                    sql.execute("CREATE TABLE permission_probe (value TEXT)");
                    sql.execute("INSERT INTO permission_probe VALUES ('fixture')");
                    for (String suffix : List.of("-wal", "-shm")) {
                        Path sidecar = data.resolve(name + suffix);
                        check(Files.exists(sidecar), "real SQLite sidecar exists"); PrivateFiles.verify(sidecar);
                        System.out.println("SQLite " + suffix + " native private permissions verified");
                    }
                }
            }
            for (String suffix : List.of("-wal", "-shm", "-journal")) if (Files.exists(data.resolve(name + suffix))) PrivateFiles.verify(data.resolve(name + suffix));
        }
    }
    private static void construct(String store, Path data) {
        switch (store) { case "connection" -> new ConnectionStore(data, "1001"); case "audit" -> new AuditStore(data); default -> new McpTokenStore(data); }
    }
    private static void storeUnsafe(IOAction action) throws Exception {
        try { action.run(); throw new AssertionError("Unsafe store path accepted"); } catch (ConnectionStore.StoreException | AuditStore.Unavailable | McpTokenStore.Unavailable expected) { }
    }
    static void unsafe(IOAction action) throws Exception {
        try { action.run(); throw new AssertionError("Unsafe storage accepted"); }
        catch (java.io.IOException expected) { check(!expected.getMessage().contains("private.key"), "errors do not disclose paths"); }
    }
    static void remove(Path root) throws Exception { try (var paths = Files.walk(root)) { for (Path p : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(p); } }
    static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
