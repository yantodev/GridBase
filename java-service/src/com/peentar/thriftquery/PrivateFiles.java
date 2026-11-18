package com.peentar.thriftquery;

import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.*;

/** Native private storage. Only managed paths are repaired; ancestors are never chmod'ed. */
final class PrivateFiles {
    private static final LinkOption[] NOFOLLOW = {LinkOption.NOFOLLOW_LINKS};
    private static final Set<PosixFilePermission> DIR = PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> FILE = PosixFilePermissions.fromString("rw-------");
    private PrivateFiles() { }

    static void createDirectory(Path path) throws IOException { prepare(path, true); }
    static void createFile(Path path) throws IOException { prepare(path, false); }
    /** Exclusive creation for new key material. Never ensure/repair and then open for writing. */
    static java.nio.channels.FileChannel createNewFile(Path supplied) throws IOException {
        java.nio.channels.FileChannel channel = null;
        try {
            Path path = supplied.toAbsolutePath().normalize();
            checkPath(path);
            Path parent = path.getParent();
            if (parent == null) throw unsafe();
            if (!Files.exists(parent, NOFOLLOW)) createDirectory(parent);
            FileAttribute<?> attribute = attributes(parent, false);
            channel = java.nio.channels.FileChannel.open(path,
                    Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS), attribute);
            verify(path);
            return channel;
        } catch (Exception failure) {
            if (channel != null) try { channel.close(); } catch (IOException ignored) { }
            throw unsafe();
        }
    }
    static void createFileExisting(Path path) throws IOException {
        prepare(path, false, false);
    }

    private static void prepare(Path supplied, boolean directory) throws IOException {
        prepare(supplied, directory, true);
    }
    private static void prepare(Path supplied, boolean directory, boolean create) throws IOException {
        try {
            Path path = supplied.toAbsolutePath().normalize();
            checkPath(path);
            if (create && !Files.exists(path, NOFOLLOW)) {
                Path parent = path.getParent();
                if (parent == null) throw unsafe();
                if (!Files.exists(parent, NOFOLLOW)) createDirectory(parent);
                FileAttribute<?> attribute = attributes(parent, directory);
                try {
                    if (directory) Files.createDirectory(path, attribute); else Files.createFile(path, attribute);
                } catch (FileAlreadyExistsException raced) { /* Validate, never replace. */ }
            }
            var basic = Files.readAttributes(path, BasicFileAttributes.class, NOFOLLOW);
            if (directory != basic.isDirectory() || !directory && !basic.isRegularFile()) throw unsafe();
            checkOwner(path);
            if (posix(path)) Files.setPosixFilePermissions(path, directory ? DIR : FILE);
            else acl(path).setAcl(privateAcl(currentUser(path), directory));
            verify(path);
        } catch (Exception error) { throw unsafe(); }
    }

    static void verify(Path supplied) throws IOException {
        try {
            Path path = supplied.toAbsolutePath().normalize();
            checkPath(path); checkOwner(path);
            var basic = Files.readAttributes(path, BasicFileAttributes.class, NOFOLLOW);
            if (!basic.isDirectory() && !basic.isRegularFile()) throw unsafe();
            verifyPermissions(path, basic);
        } catch (Exception error) { throw unsafe(); }
    }
    private static void verifyPermissions(Path path, BasicFileAttributes basic) throws Exception {
        if (posix(path)) {
            if (!Files.getPosixFilePermissions(path, NOFOLLOW).equals(basic.isDirectory() ? DIR : FILE)) throw unsafe();
            if (basic.isRegularFile() && ((Number) Files.getAttribute(path, "unix:nlink", NOFOLLOW)).longValue() != 1) throw unsafe();
        } else {
            UserPrincipal owner = currentUser(path);
            boolean ownerFull = false;
            for (AclEntry entry : acl(path).getAcl()) {
                // Owner-only policy is shared with required-file validation.
                if (!entry.principal().equals(owner) || entry.type() != AclEntryType.ALLOW) throw unsafe();
                if (!entry.flags().contains(AclEntryFlag.INHERIT_ONLY)
                        && entry.permissions().containsAll(EnumSet.allOf(AclEntryPermission.class))) ownerFull = true;
            }
            if (!ownerFull) throw unsafe();
        }
    }

    /** Reject symlinks, Windows junction/reparse redirection, and non-directory ancestors. */
    static void checkPath(Path supplied) throws IOException {
        try {
            Path path = supplied.toAbsolutePath().normalize();
            Path current = path.getRoot();
            for (Path part : path) {
                current = current.resolve(part);
                if (!Files.exists(current, NOFOLLOW)) continue;
                var attrs = Files.readAttributes(current, BasicFileAttributes.class, NOFOLLOW);
                if (attrs.isSymbolicLink() || attrs.isOther() || !current.equals(path) && !attrs.isDirectory()) throw unsafe();
                if (!current.toRealPath().equals(current)) throw unsafe();
            }
        } catch (Exception error) { throw unsafe(); }
    }

    /** Check existing SQLite sidecars before the native driver can follow them. */
    static void database(Path database) throws IOException {
        databasePaths(database);
        createFile(database);
    }
    static void databasePaths(Path database) throws IOException { databasePaths(database, false); }
    /** Existing store operation: never recreate a missing database or parent. */
    static void databaseExisting(Path database) throws IOException { databasePaths(database, true); }
    /** SQLite READWRITE only (SQLITE_OPEN_READWRITE=2): required main is never created by native open. */
    static Properties sqliteExistingOptions() {
        Properties options = new Properties(); options.setProperty("open_mode", "2"); return options;
    }
    private static void databasePaths(Path database, boolean required) throws IOException {
        try {
            database = database.toAbsolutePath().normalize();
            if (required) verify(database.getParent()); else createDirectory(database.getParent());
            boolean mainPresent;
            try { Files.readAttributes(database, BasicFileAttributes.class, NOFOLLOW); mainPresent = true; }
            catch (NoSuchFileException absent) {
                if (required || !missingLeaf(absent, database)) throw absent;
                verify(database.getParent()); mainPresent = false;
            }
            if (mainPresent) createFileExisting(database);
            for (String suffix : List.of("-wal", "-shm", "-journal"))
                optionalSidecar(database.resolveSibling(database.getFileName() + suffix), database, mainPresent);
        } catch (Exception failure) { throw unsafe(failure); }
    }
    /** SQLite, not this helper, owns optional sidecar creation and removal. */
    private static void optionalSidecar(Path sidecar, Path database, boolean mainPresent) throws Exception {
        try { verifySidecar(sidecar); }
        catch (NoSuchFileException | SidecarReplaced changed) {
            if (changed instanceof NoSuchFileException disappeared && !missingLeaf(disappeared, sidecar)) throw disappeared;
            verifyDatabaseAnchor(database, mainPresent);
            // SQLite can replace a sidecar with or without an observed absence.
            // Finish only after full stable validation or typed exact-leaf absence.
            for (int observation = 0; observation < 16; observation++) {
                try { Files.readAttributes(sidecar, BasicFileAttributes.class, NOFOLLOW); }
                catch (NoSuchFileException confirmed) {
                    if (!missingLeaf(confirmed, sidecar)) throw confirmed;
                    return; // Parent/main were revalidated immediately before this probe.
                }
                try { verifySidecar(sidecar); return; }
                catch (NoSuchFileException | SidecarReplaced changedAgain) {
                    if (changedAgain instanceof NoSuchFileException disappeared && !missingLeaf(disappeared, sidecar)) throw disappeared;
                    verifyDatabaseAnchor(database, mainPresent);
                }
            }
            throw unsafe(); // Fail closed on continuous adversarial replacement churn.
        }
    }
    private static boolean missingLeaf(NoSuchFileException missing, Path leaf) {
        return missing.getFile() != null && Path.of(missing.getFile()).toAbsolutePath().normalize().equals(leaf);
    }
    private static void verifyDatabaseAnchor(Path database, boolean mainPresent) throws Exception {
        verify(database.getParent()); // No creation/repair after a disappearance.
        if (mainPresent) verify(database);
        else {
            try { Files.readAttributes(database, BasicFileAttributes.class, NOFOLLOW); verify(database); }
            catch (NoSuchFileException absent) {
                if (!missingLeaf(absent, database)) throw absent;
                verify(database.getParent()); // Initial creation may legitimately have no main yet.
            }
        }
    }
    private static void verifySidecar(Path path) throws Exception {
        checkPath(path.getParent());
        var before = Files.readAttributes(path, BasicFileAttributes.class, NOFOLLOW);
        if (!before.isRegularFile() || before.isSymbolicLink() || before.isOther()) throw unsafe();
        if (!path.toRealPath().equals(path)) throw unsafe();
        checkOwner(path);
        verifyPermissions(path, before); // Read-only: never chmod/recreate a transient file.
        var after = Files.readAttributes(path, BasicFileAttributes.class, NOFOLLOW);
        if (!after.isRegularFile() || after.isSymbolicLink() || after.isOther()
                || before.fileKey() == null || after.fileKey() == null) throw unsafe();
        // A native last-close/reopen can leave a new regular sidecar without an
        // observed absence. This signal never validates the replacement: only the
        // optional-sidecar caller may restart full validation with strict anchors.
        if (!Objects.equals(before.fileKey(), after.fileKey())) throw new SidecarReplaced();
    }
    private static final class SidecarReplaced extends Exception { }

    private static void checkOwner(Path path) throws Exception {
        if (!Files.getOwner(path, NOFOLLOW).equals(currentUser(path))) throw unsafe();
        if (posix(path) && Files.isRegularFile(path, NOFOLLOW)
                && ((Number) Files.getAttribute(path, "unix:nlink", NOFOLLOW)).longValue() != 1) throw unsafe();
    }
    private static boolean posix(Path path) { return Files.getFileAttributeView(path, PosixFileAttributeView.class, NOFOLLOW) != null; }
    private static UserPrincipal currentUser(Path path) throws Exception {
        // Obtain native process identity, not a mutable user.name property or localized account name.
        if (posix(path)) {
            var identity = Class.forName("com.sun.security.auth.module.UnixSystem").getConstructor().newInstance();
            long uid = ((Number) identity.getClass().getMethod("getUid").invoke(identity)).longValue();
            return principal(path, Long.toString(uid));
        }
        var identity = Class.forName("com.sun.security.auth.module.NTSystem").getConstructor().newInstance();
        String name = (String) identity.getClass().getMethod("getName").invoke(identity);
        String domain = (String) identity.getClass().getMethod("getDomain").invoke(identity);
        // Java's Windows lookup takes an account name, not a textual SID. Native
        // NTSystem resolves the actual account/domain independently of localization.
        return principal(path, domain == null || domain.isEmpty() ? name : domain + "\\" + name);
    }
    private static UserPrincipal principal(Path path, String name) throws IOException { return path.getFileSystem().getUserPrincipalLookupService().lookupPrincipalByName(name); }
    private static AclFileAttributeView acl(Path path) throws IOException {
        if (!System.getProperty("os.name").startsWith("Windows") || path.getFileSystem() != FileSystems.getDefault()) throw unsafe();
        var view = Files.getFileAttributeView(path, AclFileAttributeView.class, NOFOLLOW);
        if (view == null) throw unsafe();
        return view;
    }
    private static List<AclEntry> privateAcl(UserPrincipal owner, boolean directory) {
        var entry = AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(owner).setPermissions(EnumSet.allOf(AclEntryPermission.class));
        if (directory) entry.setFlags(AclEntryFlag.DIRECTORY_INHERIT, AclEntryFlag.FILE_INHERIT);
        return List.of(entry.build());
    }
    private static FileAttribute<?> attributes(Path parent, boolean directory) throws Exception {
        if (posix(parent)) return PosixFilePermissions.asFileAttribute(directory ? DIR : FILE);
        // Java 17 acl:acl does NOT set SE_DACL_PROTECTED. Windows may merge
        // inherited parent ACEs at creation; post-creation repair cannot undo exposure.
        // Accept only a native, owner-controlled parent with safe inheritable policy.
        checkPath(parent);
        if (!Files.isDirectory(parent, NOFOLLOW)) throw unsafe();
        checkOwner(parent);
        UserPrincipal owner = currentUser(parent);
        verifyInheritedAcl(acl(parent).getAcl(), owner); // BEFORE either directory/file CREATE.
        List<AclEntry> entries = privateAcl(owner, directory);
        return new FileAttribute<List<AclEntry>>() {
            public String name() { return "acl:acl"; }
            public List<AclEntry> value() { return entries; }
        };
    }
    static void verifyInheritedAcl(List<AclEntry> entries, UserPrincipal owner) throws IOException {
        boolean ownerFull = false;
        for (AclEntry entry : entries) {
            boolean inheritable = entry.flags().contains(AclEntryFlag.FILE_INHERIT)
                    || entry.flags().contains(AclEntryFlag.DIRECTORY_INHERIT);
            // Check both inheritance flags regardless of requested child type: a
            // FILE_INHERIT-only ACE can propagate through newly created directories.
            if (inheritable && (entry.type() != AclEntryType.ALLOW || !entry.principal().equals(owner))) throw unsafe();
            // A non-owner allowed to rewrite this parent's policy could race the
            // preflight. Refuse that policy rather than modifying a shared ancestor.
            if (entry.type() != AclEntryType.ALLOW || !entry.principal().equals(owner)
                    && !Collections.disjoint(entry.permissions(), Set.of(AclEntryPermission.WRITE_ACL,
                    AclEntryPermission.WRITE_OWNER, AclEntryPermission.DELETE_CHILD))) throw unsafe();
            if (entry.principal().equals(owner) && !entry.flags().contains(AclEntryFlag.INHERIT_ONLY)
                    && entry.permissions().containsAll(EnumSet.allOf(AclEntryPermission.class))) ownerFull = true;
        }
        // Java maps both a null DACL (unrestricted) and an empty one to an empty
        // list. Neither is accepted as a demonstrably supported private parent.
        if (!ownerFull) throw unsafe();
    }
    private static IOException unsafe() { return new IOException("Private storage is unsafe or unavailable. Use a current-user-owned local directory with native private permissions; remove links or unsafe access grants."); }
    private static IOException unsafe(Exception cause) { IOException error = unsafe(); error.initCause(cause); return error; }
}
