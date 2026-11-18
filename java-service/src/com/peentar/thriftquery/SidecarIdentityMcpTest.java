package com.peentar.thriftquery;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.sql.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Deterministic native identity turnover; hooks exist only in disposable source copies. */
public final class SidecarIdentityMcpTest {
    private static final CountDownLatch OBSERVED = new CountDownLatch(1), RELEASE = new CountDownLatch(1);
    private static final AtomicBoolean FIRED = new AtomicBoolean();
    private static volatile boolean armed;
    private static String mode, suffix;
    private static Path database, leaf, data, root;
    private static Connection replacement;
    private static int observations, mutations, ownerVisits;
    private static final AtomicInteger jdbcEntries = new AtomicInteger();

    public static void main(String[] args) throws Exception {
        if (args.length == 4 && args[0].equals("worker")) { worker(Path.of(args[1]), args[2], args[3]); return; }
        Path root = Files.createTempDirectory("sidecar-identity-空 間");
        int cases = 0, failed = 0;
        try {
            Path classes = PrivateFilesSidecarLifecycleTest.instrument(root);
            List<String> modes = args.length != 0 && args[0].equals("native") ? List.of("native-reopen", "mcp-reopen")
                    : List.of("native-reopen", "mcp-reopen", "identity-repeat", "identity-churn", "unknown-key", "unsafe-symlink", "unsafe-directory", "unsafe-hardlink", "unsafe-mode", "unsafe-owner", "unsafe-denied", "unsafe-generic", "missing-main", "missing-parent");
            for (String suffix : List.of("-wal", "-shm")) for (String mode : modes) {
                if (!Files.getFileStore(root).supportsFileAttributeView("posix") && Set.of("unsafe-symlink", "unsafe-hardlink", "unsafe-mode").contains(mode)) {
                    System.out.println("SKIP POSIX-only identity fixture " + mode + " " + suffix); continue;
                }
                Process child = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-ea", "--add-modules", "jdk.httpserver", "-cp",
                        classes + File.pathSeparator + System.getProperty("java.class.path"), SidecarIdentityMcpTest.class.getName(), "worker", root.resolve("case-" + cases).toString(), mode, suffix).redirectErrorStream(true).start();
                try {
                    check(child.waitFor(25, TimeUnit.SECONDS), "Identity fixture deadline");
                    System.out.print(new String(child.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
                    System.out.println("IDENTITY_CASE=" + mode + suffix + " TRUE_EXIT=" + child.exitValue());
                    if (child.exitValue() != 0) failed++;
                    cases++;
                } finally { if (child.isAlive()) { child.destroyForcibly(); child.waitFor(5, TimeUnit.SECONDS); } }
            }
            check(failed == 0, "Identity regressions failed=" + failed + " cases=" + cases);
            System.out.println("Sidecar identity passed: " + cases + " deterministic JVM cases (native WAL/SHM turnover + stored-profile MCP HTTP; controlled churn/unsafe/unknown-identity cases)");
            System.out.println("Windows/AppData and POSIX foreign-owner remain UNVERIFIED; owner denial here is controlled injection, not native evidence");
        } finally { PrivateFilesTest.remove(root); }
    }
    private static boolean target(Path path) {
        return armed && path.equals(leaf) && (!mode.equals("mcp-reopen")
                || Arrays.stream(Thread.currentThread().getStackTrace()).anyMatch(frame -> frame.getClassName().equals("com.peentar.thriftquery.LocalWorkspace") && frame.getMethodName().equals("validate")));
    }
    public static void mutation(Path path) {
        if (armed && path.getFileName().toString().matches(".*\\.sqlite-(wal|shm|journal)")) { mutations++; throw new AssertionError("Helper attempted optional sidecar creation/permission repair"); }
    }
    public static void afterOwner(Path path) throws Exception {
        if (!target(path)) return;
        ownerVisits++;
        if (observations > 0) {
            if (mode.equals("unsafe-owner") || mode.equals("unsafe-denied")) throw new AccessDeniedException(path.toString());
            if (mode.equals("unsafe-generic")) throw new IOException("Controlled provider failure");
        }
    }
    public static void beforeSecondAttributes(Path path) throws Exception {
        if (!target(path) || Set.of("identity-repeat", "identity-churn", "unknown-key").contains(mode) || !FIRED.compareAndSet(false, true)) return;
        OBSERVED.countDown(); check(RELEASE.await(10, TimeUnit.SECONDS), "Native identity barrier release");
    }
    public static BasicFileAttributes attributes(Path path, BasicFileAttributes actual, boolean first) throws Exception {
        if (!target(path)) return actual;
        if (!first) {
            observations++;
            if (observations == 1 && Set.of("unsafe-symlink", "unsafe-directory", "unsafe-hardlink", "unsafe-mode", "missing-main", "missing-parent").contains(mode)) {
                replacement.close(); replacement = null;
                if (mode.equals("missing-main")) { Files.delete(database); return actual; }
                if (mode.equals("missing-parent")) { Files.move(data, root.resolve("held-data")); return actual; }
                Path sentinel = root.resolve("sentinel"); Files.writeString(sentinel, "untouched fixture");
                switch (mode) {
                    case "unsafe-symlink" -> Files.createSymbolicLink(leaf, sentinel);
                    case "unsafe-directory" -> Files.createDirectory(leaf);
                    case "unsafe-hardlink" -> Files.createLink(leaf, sentinel);
                    case "unsafe-mode" -> {
                        Files.createFile(leaf);
                        Files.setPosixFilePermissions(leaf, PosixFilePermissions.fromString("rw-r--r--")); // Explicit fixture bypasses private umask.
                        check(Files.getPosixFilePermissions(leaf).contains(PosixFilePermission.GROUP_READ), "Unsafe-mode fixture is actually unsafe");
                    }
                }
            }
        }
        if (mode.equals("identity-repeat") && (first ? observations >= 3 : observations > 3)) return actual;
        if (!Set.of("identity-repeat", "identity-churn", "unknown-key").contains(mode)) return actual;
        Object key = mode.equals("unknown-key") ? null : new Object();
        // Controlled provider identity only: never used as native filesystem evidence.
        return new BasicFileAttributes() {
            public FileTime lastModifiedTime() { return actual.lastModifiedTime(); }
            public FileTime lastAccessTime() { return actual.lastAccessTime(); }
            public FileTime creationTime() { return actual.creationTime(); }
            public boolean isRegularFile() { return actual.isRegularFile(); }
            public boolean isDirectory() { return actual.isDirectory(); }
            public boolean isSymbolicLink() { return actual.isSymbolicLink(); }
            public boolean isOther() { return actual.isOther(); }
            public long size() { return actual.size(); }
            public Object fileKey() { return key; }
        };
    }
    private static Connection nativeReader() throws Exception {
        Connection connection = DriverManager.getConnection("jdbc:sqlite:" + database, PrivateFiles.sqliteExistingOptions());
        try (var sql = connection.createStatement(); var rows = sql.executeQuery("SELECT count(*) FROM audit_events")) { check(rows.next(), "Native SQLite reader"); }
        return connection;
    }
    private static void worker(Path supplied, String scenario, String sidecar) throws Exception {
        root = supplied; mode = scenario; suffix = sidecar; data = root.resolve("data"); database = data.resolve("audit.sqlite"); leaf = data.resolve("audit.sqlite" + suffix);
        AppConfig config = AppConfig.local(root.resolve("resources"), data, root.resolve("temp"), "desktop");
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try (LocalWorkspace workspace = LocalWorkspace.open(data, new CredentialKey(LocalEngineProcessTest.keyBytes()))) {
            var stores = new ConnectionWorkspaces(config, workspace, profile -> new JdbcService(config, profile, () -> { jdbcEntries.incrementAndGet(); return McpSdkTest.fixture(); }));
            var registry = stores.forOwner(workspace.actor()); registry.save("sdk-fixture", ConnectionSettings.fromJson(LocalMcpTest.PROFILE));
            AuditStore audit = new AuditStore(data);
            try (LocalMcpTest.Control control = new LocalMcpTest.Control(config, stores, workspace)) {
                control.start(); control.set(true, LocalMcpTest.port());
                var profile = registry.mcp("sdk-fixture");
                var tokenStore = new McpTokenStore(data);
                var token = tokenStore.create(workspace.actor(), "identity-fixture", "read_only", 30, List.of(new McpTokenStore.Grant(profile.id(), profile.generation(), true)));
                String tokensBefore = tokenStore.list(workspace.actor().ownerKey()).stream().map(McpTokenStore.Token::toJson).collect(java.util.stream.Collectors.joining());
                Connection old = nativeReader();
                check(Files.isRegularFile(leaf), "Native SQLite sidecar exists");
                Object oldKey = Files.readAttributes(leaf, BasicFileAttributes.class).fileKey();
                try (var held = FileChannel.open(leaf, StandardOpenOption.READ)) {
                    armed = true;
                    Future<Exception> result = worker.submit(() -> {
                        try {
                            if (mode.equals("mcp-reopen")) {
                                String response = LocalMcpTest.call(control.endpoint(), token.secret(), "list_connections", "{}");
                                var rpc = StrictJson.object(response).getAsJsonObject("result");
                                check(!rpc.get("isError").getAsBoolean(), "Native turnover MCP tool must succeed");
                                var content = StrictJson.object(rpc.getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());
                                check(content.getAsJsonArray("connections").size() == 1 && content.getAsJsonArray("connections").get(0).getAsJsonObject().get("id").getAsString().equals("sdk-fixture"), "Unchanged authorized stored profile returned");
                            } else PrivateFiles.databaseExisting(database);
                            return null;
                        } catch (Exception failure) { return failure; }
                    });
                    if (!Set.of("identity-repeat", "identity-churn", "unknown-key").contains(mode)) {
                        check(OBSERVED.await(10, TimeUnit.SECONDS), "Validated sidecar first observation reached");
                        old.close(); check(!Files.exists(leaf), "Native last-close removed sidecar");
                        replacement = nativeReader();
                        check(!Objects.equals(oldKey, Files.readAttributes(leaf, BasicFileAttributes.class).fileKey()), "Native reopen changed identity without missing exception injection");
                        System.out.println("NATIVE_CLOSE_REOPEN=" + suffix + " DIFFERENT_FILE_KEY=true NO_INJECTED_MISSING=true");
                        RELEASE.countDown();
                    }
                    Exception failure;
                    try { failure = result.get(10, TimeUnit.SECONDS); }
                    catch (ExecutionException failed) { throw new AssertionError("Identity fixture assertion", failed.getCause()); }
                    armed = false;
                    if (Set.of("native-reopen", "mcp-reopen", "identity-repeat").contains(mode)) {
                        check(failure == null, "Stable native replacement rejected: " + (failure == null ? "none" : failure.getClass().getSimpleName()));
                        check(observations >= 2 && ownerVisits >= 2, "Surviving identity fully revalidated");
                        if (mode.equals("identity-repeat")) check(observations == 4 && ownerVisits == 4, "Three controlled replacements followed by full stable validation");
                        PrivateFiles.verify(leaf);
                        if (mode.equals("mcp-reopen")) {
                            check(jdbcEntries.get() == 0, "list_connections never entered external JDBC");
                            check(tokensBefore.equals(tokenStore.list(workspace.actor().ownerKey()).stream().map(McpTokenStore.Token::toJson).collect(java.util.stream.Collectors.joining())), "Token/grants unchanged");
                            check(audit.list(workspace.actor().ownerKey(), false, Map.of()).events().stream().anyMatch(e -> e.action.equals("mcp.connections") && e.outcome.equals("success") && token.token().id().equals(e.tokenId)), "Actual MCP successful audit");
                            System.out.println("MCP_HTTP_SUCCESS=true JDBC_ENTRIES=0 TOKEN_GRANTS_UNCHANGED=true");
                        }
                        durable(audit);
                    } else {
                        check(failure instanceof IOException, "Unsafe/churn/unknown identity must fail closed");
                        check(!failure.getMessage().contains(root.toString()), "Public error sanitized");
                        if (mode.equals("identity-churn")) check(observations == 17, "Initial observation plus exactly16 bounded revalidations");
                        if (mode.equals("unknown-key")) check(observations == 1, "Unknown identity not accepted/retried");
                        if (mode.equals("missing-main")) check(!Files.exists(database), "Required main not recreated");
                        if (mode.equals("missing-parent")) check(!Files.exists(data), "Required parent not recreated");
                        if (mode.equals("unsafe-mode")) check(Files.getPosixFilePermissions(leaf).equals(PosixFilePermissions.fromString("rw-r--r--")), "Unsafe permissions not repaired by helper");
                        if (Files.exists(root.resolve("sentinel"))) check(Files.readString(root.resolve("sentinel")).equals("untouched fixture"), "Unsafe target unchanged");
                        System.out.println("CONTROLLED_DENIAL=" + mode + " OBSERVATIONS=" + observations);
                    }
                    check(mutations == 0, "No helper sidecar create/chmod calls");
                } finally { armed = false; RELEASE.countDown(); old.close(); if (replacement != null) replacement.close(); }
            }
            System.out.println("PASS identity " + mode + " " + suffix);
        } finally { RELEASE.countDown(); worker.shutdownNow(); }
    }
    private static void durable(AuditStore audit) throws Exception {
        var event = new AuditStore.Event(new GitHubAuth.User("1001", "fixture"), "query.execute", "server");
        audit.begin(event); check(outcome(event.requestId).equals("pending"), "Exact durable audit intent");
        event.outcome = "success"; event.code = "OK"; event.httpStatus = 200; event.finishedAt = System.currentTimeMillis(); event.durationMs = 0L;
        audit.finish(event); check(outcome(event.requestId).equals("success"), "Exact durable audit completion");
        System.out.println("DURABLE_PENDING_AND_SUCCESS=true");
    }
    private static String outcome(String id) throws Exception {
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + database, PrivateFiles.sqliteExistingOptions()); var sql = connection.prepareStatement("SELECT outcome FROM audit_events WHERE request_id=?")) {
            sql.setString(1, id); try (var rows = sql.executeQuery()) { check(rows.next(), "Exact event persisted"); return rows.getString(1); }
        }
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
