package com.peentar.thriftquery;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;
import javax.tools.ToolProvider;

/** Real native SQLite lifecycle; barriers exist only in a disposable source copy. */
public final class PrivateFilesSidecarLifecycleTest {
    private static final CountDownLatch OBSERVED = new CountDownLatch(1), RELEASE = new CountDownLatch(1);
    private static volatile String mode, suffix;
    private static boolean fired;
    private static int replacementObservations;
    private static int cases;

    public static void main(String[] args) throws Exception {
        if (args.length != 0) { worker(Path.of(args[0]), args[1], args[2]); return; }
        Path root = Files.createTempDirectory("storage-lifecycle-空 間");
        try {
            Path classes = instrument(root);
            for (String sidecar : List.of("-wal", "-shm")) {
                for (String scenario : List.of("native-close", "valid-replacement", "reappearing-replacement", "symlink-replacement", "directory-replacement", "hardlink-replacement", "unsafe-mode-replacement", "denied", "generic-error", "native-denied", "wrong-missing-leaf", "missing-main", "missing-parent", "required-file")) {
                    if (!Files.getFileStore(root).supportsFileAttributeView("posix")
                            && Set.of("symlink-replacement", "hardlink-replacement", "unsafe-mode-replacement", "native-denied").contains(scenario)) {
                        System.out.println("SKIP POSIX-specific " + scenario + "; no native Windows equivalence claimed"); continue;
                    }
                    Path fixture = root.resolve("case-" + cases++);
                    Process child = start(classes, fixture, scenario, sidecar);
                    try {
                        check(child.waitFor(25, TimeUnit.SECONDS), "Lifecycle worker deadline");
                        String output = new String(child.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                        System.out.print(output);
                        check(child.exitValue() == 0, "Lifecycle scenario failed: " + scenario + " " + sidecar + " exit=" + child.exitValue());
                    } finally { if (child.isAlive()) { child.destroyForcibly(); child.waitFor(5, TimeUnit.SECONDS); } }
                }
            }
            for (String requiredMode : List.of("required-open", "native-open")) {
                Process required = start(classes, root.resolve(requiredMode), requiredMode, "-wal");
                try {
                    check(required.waitFor(25, TimeUnit.SECONDS), "Required-open worker deadline");
                    System.out.print(new String(required.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
                    check(required.exitValue() == 0, "Required database vanished between preflight calls must not be recreated"); cases++;
                } finally { if (required.isAlive()) required.destroyForcibly(); }
            }
            System.out.println("Private sidecar lifecycle passed: " + cases + " controlled JVM cases; real SQLite WAL/SHM unlink, durable audit, no recreation, replacements and typed denial");
            System.out.println("Controlled AccessDenied/generic/missing-observation injection plus native POSIX access-denial checks; native Windows and POSIX foreign-owner remain UNVERIFIED");
        } finally { PrivateFilesTest.remove(root); }
    }

    static Path instrument(Path root) throws Exception {
        Path original = Path.of("java-service/src/com/peentar/thriftquery/PrivateFiles.java");
        String text = Files.readString(original);
        // Existing owner validation is the observable point immediately before
        // permission validation/repair in both the pre-fix and fixed helper.
        check(text.contains("checkOwner(path);"), "Owner-validation instrumentation anchor");
        text = text.replace("checkOwner(path);", "checkOwner(path); PrivateFilesSidecarLifecycleTest.afterOwner(path);");
        text = text.replace("checkOwner(path); PrivateFilesSidecarLifecycleTest.afterOwner(path);", "checkOwner(path); PrivateFilesSidecarLifecycleTest.afterOwner(path); SidecarIdentityMcpTest.afterOwner(path);");
        String secondAttributes = "var after = Files.readAttributes(path, BasicFileAttributes.class, NOFOLLOW);";
        check(text.contains(secondAttributes), "Identity observation instrumentation anchor");
        text = text.replace(secondAttributes, "SidecarIdentityMcpTest.beforeSecondAttributes(path); " + secondAttributes + " after = SidecarIdentityMcpTest.attributes(path, after, false);");
        String firstAttributes = "var before = Files.readAttributes(path, BasicFileAttributes.class, NOFOLLOW);";
        check(text.contains(firstAttributes), "First identity observation instrumentation anchor");
        text = text.replace(firstAttributes, firstAttributes + " before = SidecarIdentityMcpTest.attributes(path, before, true);");
        String prepare = "private static void prepare(Path supplied, boolean directory, boolean create) throws IOException {";
        check(text.contains(prepare), "Optional sidecar no-mutation instrumentation anchor");
        text = text.replace(prepare, prepare + " SidecarIdentityMcpTest.mutation(supplied);");
        Path source = root.resolve("source/PrivateFiles.java"), classes = root.resolve("classes");
        Files.createDirectories(source.getParent()); Files.createDirectory(classes); Files.writeString(source, text);
        int status = ToolProvider.getSystemJavaCompiler().run(null, System.out, System.err, "--release", "17", "-cp", System.getProperty("java.class.path"), "-d", classes.toString(), source.toString());
        check(status == 0, "Disposable PrivateFiles copy compiled");
        String audit = Files.readString(original.resolveSibling("AuditStore.java"));
        String anchor = "PrivateFiles.createFileExisting(database);\n        PrivateFiles.database(database);";
        if (audit.contains(anchor)) audit = audit.replace(anchor, "PrivateFiles.createFileExisting(database);\n        PrivateFilesSidecarLifecycleTest.beforeRequiredOpen(database);\n        PrivateFiles.database(database);");
        else {
            check(audit.contains("PrivateFiles.databaseExisting(database);"), "Required-open instrument anchor");
            audit = audit.replace("PrivateFiles.databaseExisting(database);", "PrivateFilesSidecarLifecycleTest.beforeRequiredOpen(database); PrivateFiles.databaseExisting(database);");
        }
        audit = audit.replace("Connection db = DriverManager.getConnection(\"jdbc:sqlite:\" + database", "PrivateFilesSidecarLifecycleTest.beforeNativeOpen(database); Connection db = DriverManager.getConnection(\"jdbc:sqlite:\" + database");
        Path auditSource = source.resolveSibling("AuditStore.java"); Files.writeString(auditSource, audit);
        status = ToolProvider.getSystemJavaCompiler().run(null, System.out, System.err, "--release", "17", "-cp", System.getProperty("java.class.path"), "-d", classes.toString(), auditSource.toString());
        check(status == 0, "Disposable AuditStore copy compiled");
        return classes;
    }
    private static Process start(Path classes, Path fixture, String scenario, String sidecar) throws Exception {
        String cp = classes + File.pathSeparator + System.getProperty("java.class.path");
        return new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-ea", "--add-modules", "jdk.httpserver", "-cp", cp,
                PrivateFilesSidecarLifecycleTest.class.getName(), fixture.toString(), scenario, sidecar).redirectErrorStream(true).start();
    }

    /** Called only by the disposable PrivateFiles copy, never production code. */
    public static void afterOwner(Path path) throws Exception {
        String target = mode != null && mode.equals("required-file") ? "required.key" : "audit.sqlite" + suffix;
        if (!Thread.currentThread().getName().equals("lifecycle-worker") || !path.getFileName().toString().equals(target)) return;
        if (fired) {
            if (mode.equals("reappearing-replacement") && ++replacementObservations <= 2) throw new NoSuchFileException(path.toString());
            return;
        }
        fired = true; OBSERVED.countDown();
        check(RELEASE.await(10, TimeUnit.SECONDS), "Lifecycle release barrier");
        if (mode.endsWith("replacement")) throw new NoSuchFileException(path.toString());
        if (mode.equals("wrong-missing-leaf")) throw new NoSuchFileException(path.getParent().resolve("another-file").toString());
        if (mode.equals("denied")) throw new AccessDeniedException(path.toString());
        if (mode.equals("generic-error")) throw new IOException("Controlled provider failure");
    }

    public static void beforeRequiredOpen(Path database) throws Exception {
        if (!"required-open".equals(mode) || !Thread.currentThread().getName().equals("lifecycle-worker")) return;
        OBSERVED.countDown(); check(RELEASE.await(10, TimeUnit.SECONDS), "Required main release barrier");
    }
    public static void beforeNativeOpen(Path database) throws Exception {
        if (!"native-open".equals(mode) || !Thread.currentThread().getName().equals("lifecycle-worker")) return;
        OBSERVED.countDown(); check(RELEASE.await(10, TimeUnit.SECONDS), "Native main release barrier");
    }
    private static void worker(Path root, String scenario, String sidecar) throws Exception {
        mode = scenario; suffix = sidecar;
        PrivateFiles.createDirectory(root);
        Path data = root.resolve("data"), database = data.resolve("audit.sqlite"), leaf = data.resolve("audit.sqlite" + sidecar);
        AuditStore store = new AuditStore(data);
        if (scenario.equals("required-open") || scenario.equals("native-open")) {
            ExecutorService worker = Executors.newSingleThreadExecutor(r -> new Thread(r, "lifecycle-worker"));
            var operation = worker.submit(() -> { try { store.begin(new AuditStore.Event(new GitHubAuth.User("1001", "fixture"), "query.execute", "server")); return false; } catch (AuditStore.Unavailable expected) { return true; } });
            try {
                check(OBSERVED.await(10, TimeUnit.SECONDS), "Required-open preflight barrier"); Files.delete(database); RELEASE.countDown();
                check(operation.get(10, TimeUnit.SECONDS), "Missing required main fails closed");
                check(!Files.exists(database), "Required main must not be recreated across preflight calls");
                System.out.println("PASS " + scenario + ": missing main rejected without recreation"); return;
            } finally { RELEASE.countDown(); worker.shutdownNow(); }
        }
        Connection nativeReader = DriverManager.getConnection("jdbc:sqlite:" + database);
        try (var sql = nativeReader.createStatement(); var rows = sql.executeQuery("SELECT count(*) FROM audit_events")) { check(rows.next(), "Real native reader"); }
        check(Files.isRegularFile(leaf), "Real native SQLite creates " + sidecar);
        Path required = data.resolve("required.key");
        if (scenario.equals("required-file")) PrivateFiles.createFile(required);
        ExecutorService executor = Executors.newSingleThreadExecutor(r -> new Thread(r, "lifecycle-worker"));
        Future<Exception> operation = executor.submit(() -> {
            try {
                if (scenario.equals("required-file")) PrivateFiles.createFileExisting(required);
                else PrivateFiles.databasePaths(database);
                return null;
            } catch (Exception error) { return error; }
        });
        try {
            check(OBSERVED.await(10, TimeUnit.SECONDS), "Observed existing sidecar before permissions");
            nativeReader.close(); // Last native connection, actual SQLite unlinks both WAL and SHM.
            check(!Files.exists(data.resolve("audit.sqlite-wal")) && !Files.exists(data.resolve("audit.sqlite-shm")), "Real last-close removed WAL/SHM");
            Path sentinel = root.resolve("untouched"); Files.writeString(sentinel, "fixture sentinel");
            switch (scenario) {
                case "valid-replacement", "reappearing-replacement" -> { PrivateFiles.createFile(leaf); Files.writeString(leaf, "valid surviving replacement"); }
                case "symlink-replacement" -> Files.createSymbolicLink(leaf, sentinel);
                case "directory-replacement" -> Files.createDirectory(leaf);
                case "hardlink-replacement" -> Files.createLink(leaf, sentinel);
                case "unsafe-mode-replacement" -> { PrivateFiles.createFile(leaf); Files.setPosixFilePermissions(leaf, java.nio.file.attribute.PosixFilePermissions.fromString("rw-r--r--")); }
                case "native-denied" -> Files.setPosixFilePermissions(root, java.nio.file.attribute.PosixFilePermissions.fromString("---------"));
                case "missing-main" -> Files.delete(database);
                case "missing-parent" -> Files.move(data, root.resolve("held-data"));
                case "required-file" -> Files.delete(required);
                default -> { }
            }
            RELEASE.countDown();
            Exception failure = operation.get(10, TimeUnit.SECONDS);
            if (scenario.equals("native-denied")) {
                try {
                    Files.readAttributes(leaf, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                    throw new AssertionError("Native denial fixture requires an unprivileged OS user");
                } catch (AccessDeniedException expected) { System.out.println("Native AccessDeniedException confirmed " + sidecar); }
                finally { Files.setPosixFilePermissions(root, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------")); }
            }
            if (scenario.equals("native-close")) {
                check(failure == null, "Legal native " + sidecar + " disappearance must succeed (got " + (failure == null ? "none" : failure.getClass().getSimpleName()) + ")");
                check(!Files.exists(data.resolve("audit.sqlite-wal")) && !Files.exists(data.resolve("audit.sqlite-shm")), "Permission helper never recreates optional sidecars");
                AuditStore.Event event = new AuditStore.Event(new GitHubAuth.User("1001", "fixture"), "query.execute", "server");
                store.begin(event);
                check(outcome(database, event.requestId).equals("pending"), "Audit intent is durable before external JDBC");
                event.outcome = "success"; event.code = "OK"; event.httpStatus = 200; event.finishedAt = System.currentTimeMillis(); event.durationMs = 0L;
                store.finish(event);
                check(outcome(database, event.requestId).equals("success"), "Audit completion is durable");
                System.out.println("PASS native-close " + sidecar + ": no helper recreation, pending intent and success durable");
            } else if (scenario.equals("valid-replacement") || scenario.equals("reappearing-replacement")) {
                check(failure == null, "Surviving safe replacement is actually validated");
                if (scenario.equals("reappearing-replacement")) check(replacementObservations == 3, "Each surviving replacement revalidated after successive missing observations");
                check(Files.readString(leaf).equals("valid surviving replacement"), "Replacement contents unchanged");
                PrivateFiles.verify(leaf);
                System.out.println("PASS " + scenario + " " + sidecar + ": surviving private file validated");
            } else {
                check(failure instanceof IOException, "Unsafe/error/required-file case must fail closed: " + scenario);
                check(!failure.getMessage().contains(root.toString()), "Public diagnostic sanitized");
                check(Files.readString(sentinel).equals("fixture sentinel"), "Unsafe replacement target untouched");
                if (scenario.equals("missing-main")) check(!Files.exists(database), "Missing main never recreated");
                if (scenario.equals("missing-parent")) check(!Files.exists(data), "Missing parent never recreated");
                if (scenario.equals("required-file")) check(!Files.exists(required), "Missing required key never recreated");
                System.out.println("PASS rejected " + scenario + " " + sidecar);
            }
        } finally {
            if (Files.getFileAttributeView(root, java.nio.file.attribute.PosixFileAttributeView.class) != null)
                Files.setPosixFilePermissions(root, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
            RELEASE.countDown(); nativeReader.close(); executor.shutdownNow();
        }
    }
    private static String outcome(Path database, String id) throws Exception {
        try (var db = DriverManager.getConnection("jdbc:sqlite:" + database); var sql = db.prepareStatement("SELECT outcome FROM audit_events WHERE request_id=?")) {
            sql.setString(1, id); try (var rows = sql.executeQuery()) { check(rows.next(), "Exact audit request exists"); return rows.getString(1); }
        }
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
