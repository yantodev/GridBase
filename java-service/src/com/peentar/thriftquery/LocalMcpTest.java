package com.peentar.thriftquery;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpServer;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/** Task4 boundaries: real HTTP, SQLite/settings/processes; only external JDBC is synthetic. */
public final class LocalMcpTest {
    static int assertions;
    static void check(boolean ok, String message) { assertions++; LocalAuthTest.check(ok, message); }
    static final CredentialKey KEY = new CredentialKey(LocalEngineProcessTest.keyBytes());
    static final String PROFILE = "{\"type\":\"hive\",\"name\":\"Local MCP fixture\",\"jdbcUrl\":\"jdbc:hive2://fixture/default\",\"username\":\"dummy\",\"password\":\"synthetic-password\",\"mcpReadOnly\":true}";
    // Reflection makes the first RED an assertion about the missing feature, not a compile error.
    static Object invoke(Object target, String method, Class<?>[] types, Object... values) throws Exception {
        try { return target.getClass().getDeclaredMethod(method, types).invoke(target, values); }
        catch (java.lang.reflect.InvocationTargetException failure) {
            if (failure.getCause() instanceof Exception e) throw e;
            if (failure.getCause() instanceof Error e) throw e;
            throw failure;
        } catch (NoSuchMethodException missing) { throw new AssertionError("Task4 interface missing: " + method, missing); }
    }
    static Object settings(LocalWorkspace ws) throws Exception { return invoke(ws, "mcpSettings", new Class<?>[0]); }
    static void save(LocalWorkspace ws, boolean enabled, int port) throws Exception { invoke(ws, "saveMcpSettings", new Class<?>[]{boolean.class, int.class}, enabled, port); }
    static final class Control implements AutoCloseable {
        final Object target;
        Control(AppConfig config, ConnectionWorkspaces stores, LocalWorkspace ws) throws Exception {
            try { target = Class.forName("com.peentar.thriftquery.LocalMcpControl").getDeclaredConstructor(AppConfig.class, ConnectionWorkspaces.class, LocalWorkspace.class, McpTokenStore.class, AuditStore.class)
                    .newInstance(config, stores, ws, new McpTokenStore(config.dataDir), new AuditStore(config.dataDir)); }
            catch (ClassNotFoundException missing) { throw new AssertionError("Opt-in separate local MCP listener is not implemented", missing); }
        }
        void start() throws Exception { invoke(target, "start", new Class<?>[0]); }
        void set(boolean enabled, int port) throws Exception { invoke(target, "setEnabled", new Class<?>[]{boolean.class, int.class}, enabled, port); }
        String endpoint() throws Exception { return (String) invoke(target, "endpoint", new Class<?>[0]); }
        boolean enabled() throws Exception { return (boolean) invoke(target, "enabled", new Class<?>[0]); }
        public void close() throws Exception { ((AutoCloseable) target).close(); }
    }
    public static void main(String[] args) throws Exception {
        String mode = args.length == 0 ? "all" : args[0];
        Path root = Files.createTempDirectory("task4-local-mcp 空 間");
        try {
            if (mode.equals("all") || mode.equals("settings")) settingsTests(root.resolve("settings"));
            if (mode.equals("all") || mode.equals("http")) httpTests(root.resolve("http"));
            if (mode.equals("all") || mode.equals("lifecycle")) lifecycleTests(root.resolve("lifecycle"));
            if (mode.equals("all") || mode.equals("process")) processTests(root.resolve("process"));
            if (mode.equals("sdk")) sdk(root.resolve("sdk"));
            System.out.println("Local MCP " + mode + " tests passed (" + assertions + " assertions)");
        } finally { PrivateFilesTest.remove(root); }
    }
    static AppConfig config(Path root) { return AppConfig.local(root.resolve("resources"), root.resolve("data"), root.resolve("temp"), "desktop"); }
    @FunctionalInterface interface Checked { void run() throws Exception; }
    static void denied(Checked action, String reason) throws Exception {
        try { action.run(); throw new AssertionError(reason); } catch (IOException | IllegalArgumentException expected) { assertions++; }
    }
    static int port() throws IOException { try (var socket = new java.net.ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) { return socket.getLocalPort(); } }
    static void absent(String endpoint) throws Exception {
        try { LocalAuthTest.CLIENT.send(HttpRequest.newBuilder(URI.create(endpoint)).timeout(java.time.Duration.ofSeconds(2)).GET().build(), HttpResponse.BodyHandlers.ofString()); throw new AssertionError("Disabled/closed MCP socket accepted HTTP"); }
        catch (IOException expected) { assertions++; }
    }
    static void settingsTests(Path root) throws Exception {
        AppConfig config = config(root); byte[] identity;
        int chosen = port();
        try (LocalWorkspace ws = LocalWorkspace.open(config.dataDir, KEY)) {
            Object defaults = settings(ws);
            check(!(boolean) invoke(defaults, "enabled", new Class<?>[0]) && (int) invoke(defaults, "port", new Class<?>[0]) == 4174, "Missing setting is disabled/4174");
            check(!Files.exists(config.dataDir.resolve("local-mcp.json")), "Reading defaults does not write settings");
            identity = Files.readAllBytes(config.dataDir.resolve("local-workspace.json"));
            save(ws, true, chosen);
            check((boolean) invoke(settings(ws), "enabled", new Class<?>[0]), "Authenticated save/readback");
            denied(() -> save(ws, true, 0), "Zero port accepted");
            denied(() -> save(ws, false, 65536), "Out-of-range port accepted");
            check(Arrays.equals(identity, Files.readAllBytes(config.dataDir.resolve("local-workspace.json"))), "Identity manifest unchanged");
            // Settings authenticate their own file/owner/key, independently of a busy or
            // unsafe SQLite sidecar. The SQLite store must still reject that sidecar.
            new AuditStore(config.dataDir);
            Path outsideJournal = root.resolve("outside-journal"); Files.writeString(outsideJournal, "fixture");
            Path sidecar = config.dataDir.resolve("audit.sqlite-wal"); Files.createSymbolicLink(sidecar, outsideJournal);
            try {
                check((boolean) invoke(settings(ws), "enabled", new Class<?>[0]), "Settings read does not open/repair unrelated SQLite sidecars");
                try { new AuditStore(config.dataDir); throw new AssertionError("SQLite storage sidecar guard weakened"); } catch (AuditStore.Unavailable expected) { assertions++; }
            } finally { Files.delete(sidecar); }
        }
        Path file = config.dataDir.resolve("local-mcp.json"); byte[] valid = Files.readAllBytes(file);
        try (LocalWorkspace ws = LocalWorkspace.open(config.dataDir, KEY)) {
            check((int) invoke(settings(ws), "port", new Class<?>[0]) == chosen, "Port persists across workspace restart");
            String text = new String(valid, java.nio.charset.StandardCharsets.UTF_8);
            for (byte[] bad : List.of(text.replace("\"enabled\":true", "\"enabled\":false").getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    text.replace("\"schema\":1", "\"schema\":1,\"unknown\":true").getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    text.replace("\"schema\":1", "\"schema\":1,\"schema\":1").getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    text.replace("\"port\":" + chosen, "\"port\":\"" + chosen + "\"").getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    text.replace("\"port\":" + chosen, "\"port\":" + chosen + ".0").getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    text.replace("\"enabled\":true", "\"enabled\":\"true\"").getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    "x".repeat(8193).getBytes(java.nio.charset.StandardCharsets.UTF_8), new byte[]{(byte)0xc3, (byte)0x28})) {
                Files.write(file, bad); denied(() -> settings(ws), "Unsafe/corrupt settings accepted"); Files.write(file, valid);
            }
            AppConfig other = config(root.resolve("other"));
            try (LocalWorkspace otherWs = LocalWorkspace.open(other.dataDir, KEY)) {
                Path copied = other.dataDir.resolve("local-mcp.json"); PrivateFiles.createFile(copied); Files.write(copied, valid);
                denied(() -> settings(otherWs), "Settings can be transplanted between owners with same key");
            }
            Path outside = root.resolve("outside"); Files.write(outside, valid); Files.delete(file); Files.createSymbolicLink(file, outside);
            denied(() -> settings(ws), "Settings symlink read accepted"); denied(() -> save(ws, false, chosen), "Settings symlink write accepted");
            check(Arrays.equals(valid, Files.readAllBytes(outside)), "Unsafe target unchanged"); Files.delete(file); PrivateFiles.createFile(file); Files.write(file, valid);
            if (Files.getFileAttributeView(file, java.nio.file.attribute.PosixFileAttributeView.class) != null) {
                check(Files.getPosixFilePermissions(file).equals(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")), "Settings private 0600");
                Files.setPosixFilePermissions(file, java.nio.file.attribute.PosixFilePermissions.fromString("rw-r--r--"));
                denied(() -> settings(ws), "Settings broad permissions accepted");
                Files.setPosixFilePermissions(file, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
            }
        }
        denied(() -> { try (LocalWorkspace ignored = LocalWorkspace.open(config.dataDir, new CredentialKey(new byte[32]))) { } }, "Wrong key accepted");
        Path orphan = root.resolve("orphan"); PrivateFiles.createDirectory(orphan); PrivateFiles.createFile(orphan.resolve("local-mcp.json"));
        Files.write(orphan.resolve("local-mcp.json"), valid);
        denied(() -> { try (LocalWorkspace ignored = LocalWorkspace.open(orphan, KEY)) { } }, "Orphan MCP settings adopted as a new workspace");
    }
    static HttpRequest.Builder rpc(String endpoint, String authorization, String body) {
        return HttpRequest.newBuilder(URI.create(endpoint)).timeout(java.time.Duration.ofSeconds(8)).header("Authorization", authorization)
                .header("Content-Type", "application/json").header("Accept", "application/json, text/event-stream").POST(HttpRequest.BodyPublishers.ofString(body));
    }
    static final String PING = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}";
    static String call(String endpoint, String secret, String name, String arguments) throws Exception {
        return LocalAuthTest.expect(rpc(endpoint, "Bearer " + secret, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":" + JsonUtil.quote(name) + ",\"arguments\":" + arguments + "}}"), 200).body();
    }
    static String query(String endpoint, String secret, String sql) throws Exception { return call(endpoint, secret, "execute_query", "{\"connectionId\":\"sdk-fixture\",\"sql\":" + JsonUtil.quote(sql) + "}"); }
    static String put(String base, String body, int status) throws Exception {
        return LocalAuthTest.expect(LocalAuthTest.valid(base, "/api/local/mcp").header("Content-Type", "application/json").PUT(HttpRequest.BodyPublishers.ofString(body)), status).body();
    }
    static String tokenBody(String scope) { return "{\"name\":\"fixture token\",\"scope\":" + JsonUtil.quote(scope) + ",\"expiresInDays\":30,\"connectionIds\":[\"sdk-fixture\"]}"; }
    static String token(String base, String scope, int status) throws Exception { return LocalEngineHttpTest.post(base, "/api/mcp/tokens", tokenBody(scope), status); }
    static void httpTests(Path root) throws Exception {
        AppConfig config = config(root); AtomicInteger jdbc = new AtomicInteger(); java.util.concurrent.atomic.AtomicBoolean databaseDenies = new java.util.concurrent.atomic.AtomicBoolean();
        try (LocalWorkspace ws = LocalWorkspace.open(config.dataDir, KEY)) {
            ConnectionWorkspaces stores = new ConnectionWorkspaces(config, ws, profile -> new JdbcService(config, profile, () -> {
                jdbc.incrementAndGet();
                if (databaseDenies.get()) throw new java.sql.SQLException("synthetic-permission-secret", "42501");
                return McpSdkTest.fixture();
            }));
            ThriftQueryServer app = new ThriftQueryServer(config, stores, new LocalAuth(new byte[32], ws.actor()));
            try {
                app.start(0); String base = "http://127.0.0.1:" + app.port(); int chosen = port();
                String setting = LocalEngineHttpTest.get(base, "/api/local/mcp", 200);
                check(setting.equals("{\"enabled\":false,\"endpoint\":null}"), "Default has no MCP endpoint");
                absent("http://127.0.0.1:" + chosen + "/mcp");
                LocalAuthTest.expect(LocalAuthTest.request(base, "/api/local/mcp").PUT(HttpRequest.BodyPublishers.ofString("{\"enabled\":true,\"port\":" + chosen + "}")), 401);
                LocalAuthTest.expect(LocalAuthTest.valid(base, "/api/local/mcp").header("Origin", ""), 401);
                for (String invalid : List.of("{}", "{\"enabled\":true,\"port\":0}", "{\"enabled\":true,\"port\":65536}", "{\"enabled\":true,\"port\":1.0}", "{\"enabled\":true,\"port\":\"1234\"}", "{\"enabled\":\"true\",\"port\":1234}", "{\"enabled\":true,\"enabled\":false,\"port\":1234}", "{\"enabled\":true,\"port\":1234,\"host\":\"0.0.0.0\"}")) put(base, invalid, 400);
                put(base, " ".repeat(65537), 413);
                LocalEngineHttpTest.get(base, "/api/local/mcp-extra", 404);
                LocalEngineHttpTest.get(base, "/api/local/%6dcp", 404);
                LocalEngineHttpTest.get(base, "/api/local/mcp?port=1", 400);
                var registry = stores.forOwner(ws.actor()); registry.save("sdk-fixture", ConnectionSettings.fromJson(PROFILE.replace("true", "false")));
                token(base, "read_only", 400);
                registry.save("sdk-fixture", ConnectionSettings.fromJson(PROFILE));
                String created = token(base, "read_only", 201), secret = JsonUtil.stringField(created, "secret");
                String id = StrictJson.object(created).getAsJsonObject("token").get("id").getAsString();
                check(LocalEngineHttpTest.get(base, "/api/mcp/tokens", 200).contains("\"endpoint\":null"), "Tokens list/revoke available disabled");
                String enabled = put(base, "{\"enabled\":true,\"port\":" + chosen + "}", 200), endpoint = JsonUtil.stringField(enabled, "endpoint");
                check(endpoint.equals("http://127.0.0.1:" + chosen + "/mcp"), "Actual separate loopback endpoint");
                int rebound = port(); String previousEndpoint = endpoint;
                endpoint = JsonUtil.stringField(put(base, "{\"enabled\":true,\"port\":" + rebound + "}", 200), "endpoint");
                absent(previousEndpoint); LocalAuthTest.expect(rpc(endpoint, "Bearer " + secret, PING), 200);
                chosen = rebound; enabled = "{\"enabled\":true,\"endpoint\":" + JsonUtil.quote(endpoint) + "}";
                check(LocalEngineHttpTest.get(base, "/api/auth/session", 200).contains("\"mcpEnabled\":true"), "Session reflects live listener");
                check(LocalEngineHttpTest.get(base, "/api/mcp/tokens", 200).contains(endpoint), "Management endpoint is actual separate listener");
                put(base, "{\"enabled\":true,\"port\":" + chosen + "}", 200);
                LocalEngineHttpTest.get(base, "/mcp", 404);
                LocalAuthTest.expect(rpc(endpoint, "GridBase-Local " + LocalAuthTest.CAP, PING), 401);
                LocalAuthTest.expect(rpc(endpoint, "Bearer " + LocalAuthTest.CAP, PING), 401);
                var foreignProfile = registry.mcp("sdk-fixture");
                var foreign = new McpTokenStore(config.dataDir).create(new GitHubAuth.User("1001", "browser-fixture"), "foreign", "read_only", 30,
                        List.of(new McpTokenStore.Grant(foreignProfile.id(), foreignProfile.generation(), true)));
                LocalAuthTest.expect(rpc(endpoint, "Bearer " + foreign.secret(), PING), 401);
                LocalAuthTest.expect(LocalAuthTest.request(base, "/api/local/mcp").header("Authorization", "Bearer " + secret), 401);
                LocalAuthTest.expect(LocalAuthTest.request(base, "/api/mcp/tokens").header("Authorization", "Bearer " + secret), 401);
                for (String origin : List.of("", "null", base, endpoint)) LocalAuthTest.expect(rpc(endpoint, "Bearer " + secret, PING).header("Origin", origin), 403);
                LocalAuthTest.expect(rpc(endpoint, "Bearer " + secret, PING).header("Authorization", "Bearer " + secret), 401);
                LocalAuthTest.expect(rpc(endpoint + "/extra", "Bearer " + secret, PING), 404);
                LocalAuthTest.expect(rpc(endpoint.replace("/mcp", "/%6dcp"), "Bearer " + secret, PING), 404);
                LocalAuthTest.expect(rpc(endpoint + "?x=1", "Bearer " + secret, PING), 400);
                LocalAuthTest.expect(rpc(endpoint, "Bearer " + secret, " ".repeat(65537)), 413);
                LocalAuthTest.expect(rpc(endpoint, "Bearer " + secret, PING + " ".repeat(65536 - PING.length())), 200);
                LocalAuthTest.expect(HttpRequest.newBuilder(URI.create(endpoint)).header("Cookie", "gridbase_session=1001").POST(HttpRequest.BodyPublishers.ofString(PING)), 401);
                LocalAuthTest.expect(rpc(endpoint, "Bearer " + secret, PING).header("X-GridBase-Account", "1001").header("Cookie", "gridbase_session=1001"), 200);
                check(query(endpoint, secret, "SELECT 1 AS fixture").contains("\"isError\":false"), "Read-only local MCP uses shared JDBC policy");
                int before = jdbc.get(); check(query(endpoint, secret, "DELETE FROM fixture").contains("\"isError\":true"), "Read-only write denial"); check(jdbc.get() == before, "Denial before JDBC");
                String full = JsonUtil.stringField(token(base, "full_access", 201), "secret");
                check(query(endpoint, full, "DELETE FROM fixture").contains("\"isError\":true") && jdbc.get() == before, "Full access cannot bypass read-only profile ceiling");
                // The same shared path must surface a database permission failure, never bypass it.
                registry.save("sdk-fixture", ConnectionSettings.fromJson(PROFILE.replace("true", "false")));
                String writable = JsonUtil.stringField(token(base, "full_access", 201), "secret");
                databaseDenies.set(true);
                String permissionFailure = query(endpoint, writable, "UPDATE fixture SET x=2");
                check(permissionFailure.contains("\"isError\":true") && !permissionFailure.contains("synthetic-permission-secret") && jdbc.get() == before + 1, "Full access respects database permission failure without retry or leaked error");
                databaseDenies.set(false); before = jdbc.get();
                registry.save("sdk-fixture", ConnectionSettings.fromJson(PROFILE.replace("Local MCP fixture", "Edited profile")));
                check(query(endpoint, secret, "SELECT 1").contains("\"isError\":true") && jdbc.get() == before, "Profile edit invalidates generation; grants never expand");
                registry.save("not-granted", ConnectionSettings.fromJson(PROFILE));
                check(call(endpoint, writable, "execute_query", "{\"connectionId\":\"not-granted\",\"sql\":\"SELECT 1\"}").contains("\"isError\":true") && jdbc.get() == before, "Full access cannot expand to a new ungranted profile");
                for (int i = 3; i < 20; i++) token(base, "read_only", 201);
                token(base, "read_only", 400);
                AtomicInteger contacts = new AtomicInteger(); HttpServer occupied = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
                occupied.createContext("/", e -> { contacts.incrementAndGet(); e.sendResponseHeaders(500, -1); e.close(); }); occupied.start();
                try {
                    String conflict = put(base, "{\"enabled\":true,\"port\":" + occupied.getAddress().getPort() + "}", 409);
                    check(conflict.contains("MCP_PORT_IN_USE"), "Typed actionable conflict");
                    check(LocalEngineHttpTest.get(base, "/api/local/mcp", 200).equals(enabled), "Conflict preserves working endpoint/settings");
                    LocalAuthTest.expect(rpc(endpoint, "Bearer " + secret, PING), 200);
                    check(contacts.get() == 0, "Never contact occupied process");
                } finally { occupied.stop(0); }
                put(base, "{\"enabled\":false,\"port\":" + chosen + "}", 200); absent(endpoint);
                check(LocalEngineHttpTest.get(base, "/api/auth/session", 200).contains("\"mcpEnabled\":false"), "Disabled live session");
                LocalAuthTest.expect(LocalAuthTest.valid(base, "/api/mcp/tokens/" + id).DELETE(), 200);
                put(base, "{\"enabled\":true,\"port\":" + chosen + "}", 200);
                LocalAuthTest.expect(rpc(endpoint, "Bearer " + secret, PING), 401);
                var events = new AuditStore(config.dataDir).list(ws.actor().ownerKey(), false, Map.of()).events();
                check(events.stream().anyMatch(e -> e.action.equals("token.create") && e.source.equals("desktop")), "Native token audit uses trusted client kind");
                check(events.stream().anyMatch(e -> e.action.equals("token.revoke") && e.source.equals("desktop")), "Disabled revoke audited");
                check(events.stream().anyMatch(e -> e.source.equals("mcp") && id.equals(e.tokenId) && ws.actor().ownerKey().equals(e.userId) && e.action.equals("query.execute")), "MCP audit includes local actor/token identity");
                String audit = events.stream().map(AuditStore.Event::toJson).collect(java.util.stream.Collectors.joining());
                check(!audit.contains(secret) && !audit.contains(full) && !audit.contains(LocalAuthTest.CAP) && !audit.contains(LocalEngineProcessTest.KEY), "No secrets in audit");
                byte[] savedSettings = Files.readAllBytes(config.dataDir.resolve("local-mcp.json"));
                Files.writeString(config.dataDir.resolve("local-mcp.json"), "corrupt fixture");
                put(base, "{\"enabled\":false,\"port\":" + chosen + "}", 503);
                absent(endpoint);
                check(LocalEngineHttpTest.get(base, "/api/local/mcp", 200).equals("{\"enabled\":false,\"endpoint\":null}"), "Settings corruption transition fails closed with no live listener");
                Files.write(config.dataDir.resolve("local-mcp.json"), savedSettings);
                put(base, "{\"enabled\":false,\"port\":" + chosen + "}", 200);
            } finally { app.stop(); }
        }
    }
    static void lifecycleTests(Path root) throws Exception {
        AppConfig config = config(root); CountDownLatch entered = new CountDownLatch(4), interrupted = new CountDownLatch(4), release = new CountDownLatch(1); AtomicInteger executions = new AtomicInteger();
        LocalWorkspace ws = LocalWorkspace.open(config.dataDir, KEY);
        ConnectionWorkspaces stores = new ConnectionWorkspaces(config, ws, profile -> new JdbcService(config, profile, () -> {
            executions.incrementAndGet(); entered.countDown();
            while (release.getCount() != 0) try { release.await(); } catch (InterruptedException ignored) { interrupted.countDown(); }
            throw new java.sql.SQLException("Fixture unknown result");
        }));
        ExecutorService transitions = Executors.newCachedThreadPool();
        Control control = new Control(config, stores, ws);
        try {
            control.start(); check(!control.enabled() && control.endpoint() == null, "No default listener");
            var registry = stores.forOwner(ws.actor()); registry.save("sdk-fixture", ConnectionSettings.fromJson(PROFILE.replace("true", "false")));
            var profile = registry.mcp("sdk-fixture");
            var created = new McpTokenStore(config.dataDir).create(ws.actor(), "blocking", "full_access", 30, List.of(new McpTokenStore.Grant(profile.id(), profile.generation(), false)));
            int chosen = port(); control.set(true, chosen); String endpoint = control.endpoint();
            List<CompletableFuture<HttpResponse<String>>> requests = new ArrayList<>();
            String body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"execute_query\",\"arguments\":{\"connectionId\":\"sdk-fixture\",\"sql\":\"UPDATE fixture SET x=2\"}}}";
            for (int i=0; i<4; i++) {
                requests.add(LocalAuthTest.CLIENT.sendAsync(rpc(endpoint, "Bearer " + created.secret(), body).build(), HttpResponse.BodyHandlers.ofString()));
                // Fill real worker slots one at a time. Concurrent SQLite connection churn can
                // legitimately fail closed before scheduling and is not this lifecycle contract.
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                while (executions.get() < i + 1 && System.nanoTime() < deadline) Thread.sleep(5);
            }
            boolean allEntered = entered.await(5, TimeUnit.SECONDS);
            if (!allEntered) {
                System.err.println("Task4 lifecycle diagnostic entered=" + (4 - entered.getCount()) + " executions=" + executions.get());
                for (var request : requests) if (request.isDone()) {
                    try { var response = request.get(); System.err.println("Task4 lifecycle early HTTP=" + response.statusCode() + " body=" + response.body()); }
                    catch (ExecutionException failure) { System.err.println("Task4 lifecycle early failure=" + failure.getCause().getClass().getSimpleName()); }
                }
            }
            check(allEntered, "All four owned MCP JDBC workers entered");
            Future<?> disable = transitions.submit(() -> { try { control.set(false, chosen); } catch (Exception e) { throw new CompletionException(e); } });
            check(interrupted.await(5, TimeUnit.SECONDS), "Disable requests interruption of all running JDBC workers");
            check(!control.enabled() && control.endpoint() == null, "Live state closes immediately while driver drains"); absent(endpoint);
            check(!disable.isDone(), "Disable cannot finish while driver ignores interruption");
            denied(() -> { try (LocalWorkspace ignored = LocalWorkspace.open(config.dataDir, KEY)) { } }, "Workspace lock released during driver drain");
            Future<?> reenable = transitions.submit(() -> { try { control.set(true, chosen); } catch (Exception e) { throw new CompletionException(e); } });
            check(executions.get() == 4 && !reenable.isDone(), "Reenable cannot create replacement capacity while old pool still executes");
            release.countDown(); disable.get(10, TimeUnit.SECONDS); reenable.get(10, TimeUnit.SECONDS);
            LocalAuthTest.expect(rpc(control.endpoint(), "Bearer " + created.secret(), PING), 200);
            check(executions.get() == 4, "Uncertain writes never retried");
            for (var request : requests) try { request.get(5, TimeUnit.SECONDS); } catch (ExecutionException expected) { }
        } finally { release.countDown(); control.close(); transitions.shutdownNow(); ws.close(); }
        try (LocalWorkspace reopened = LocalWorkspace.open(config.dataDir, KEY)) { check((boolean) invoke(settings(reopened), "enabled", new Class<?>[0]), "Engine close preserves explicit enable"); }
    }
    static void processTests(Path root) throws Exception {
        Files.createDirectories(root); LocalEngineProcessTest.root = root;
        Path f = LocalEngineProcessTest.fixture("restart"); int chosen = port();
        try (LocalEngineProcessTest.Child child = LocalEngineProcessTest.launch(f, LocalEngineProcessTest.normalArgs(f), 1)) {
            child.write(LocalEngineProcessTest.BOOT); String base = "http://127.0.0.1:" + child.ready().get("port").getAsInt();
            put(base, "{\"enabled\":true,\"port\":" + chosen + "}", 200);
            child.process.getOutputStream().close(); child.finish(0, 15);
        }
        try (LocalEngineProcessTest.Child child = LocalEngineProcessTest.launch(f, LocalEngineProcessTest.normalArgs(f), 1)) {
            child.write(LocalEngineProcessTest.BOOT); String base = "http://127.0.0.1:" + child.ready().get("port").getAsInt();
            check(LocalEngineHttpTest.get(base, "/api/local/mcp", 200).equals("{\"enabled\":true,\"endpoint\":\"http://127.0.0.1:" + chosen + "/mcp\"}"), "Restart binds saved explicit nondefault port before ready");
            child.process.getOutputStream().close(); child.finish(0, 15);
        }
        AtomicInteger contacts = new AtomicInteger(); HttpServer occupied = HttpServer.create(new InetSocketAddress("127.0.0.1", chosen), 0);
        occupied.createContext("/", e -> { contacts.incrementAndGet(); e.sendResponseHeaders(500, -1); e.close(); }); occupied.start();
        try (LocalEngineProcessTest.Child child = LocalEngineProcessTest.launch(f, LocalEngineProcessTest.normalArgs(f), 1)) {
            child.write(LocalEngineProcessTest.BOOT); child.failure(15); check(contacts.get() == 0, "Startup conflict fails/no ready without contacting occupied service");
        } finally { occupied.stop(0); }
        try (LocalWorkspace ws = LocalWorkspace.open(f.resolve("data"), KEY)) {
            check((boolean) invoke(settings(ws), "enabled", new Class<?>[0]), "Startup conflict preserves saved enable");
            Files.writeString(ws.dataDir().resolve("local-mcp.json"), "{\"enabled\":true}");
        }
        try (LocalEngineProcessTest.Child child = LocalEngineProcessTest.launch(f, LocalEngineProcessTest.normalArgs(f), 1)) { child.write(LocalEngineProcessTest.BOOT); child.failure(15); assertions++; }
        processMcpEof(root);
    }
    static void processMcpEof(Path root) throws Exception {
        Path f = LocalEngineProcessTest.fixture("mcp-jdbc-eof"), classes = f.resolve("test-driver-classes"), source = f.resolve("Driver.java");
        Files.createDirectory(classes);
        Files.writeString(source, """
                package org.postgresql;
                public class Driver implements java.sql.Driver {
                    static { try { java.sql.DriverManager.registerDriver(new Driver()); } catch (Exception e) { throw new ExceptionInInitializerError(e); } }
                    public java.sql.Connection connect(String url, java.util.Properties p) throws java.sql.SQLException {
                        return acceptsURL(url) ? com.peentar.thriftquery.LocalMcpTest.childJdbc() : null;
                    }
                    public boolean acceptsURL(String url) { return url.startsWith("jdbc:postgresql:"); }
                    public java.sql.DriverPropertyInfo[] getPropertyInfo(String u, java.util.Properties p) { return new java.sql.DriverPropertyInfo[0]; }
                    public int getMajorVersion() { return 1; }
                    public int getMinorVersion() { return 0; }
                    public boolean jdbcCompliant() { return false; }
                    public java.util.logging.Logger getParentLogger() { return java.util.logging.Logger.getGlobal(); }
                }
                """);
        int compiled = javax.tools.ToolProvider.getSystemJavaCompiler().run(null, System.out, System.err, "--release", "17", "-cp", System.getProperty("java.class.path"), "-d", classes.toString(), source.toString());
        check(compiled == 0, "MCP child fixture driver compiles");
        try (LocalEngineProcessTest.Child child = LocalEngineProcessTest.launch(f, LocalEngineProcessTest.normalArgs(f), 1)) {
            child.write(LocalEngineProcessTest.BOOT); String base = "http://127.0.0.1:" + child.ready().get("port").getAsInt();
            LocalEngineHttpTest.post(base, "/api/connections", LocalEngineHttpTest.PROFILE.replace("saved", "sdk-fixture"), 200);
            String secret = JsonUtil.stringField(token(base, "full_access", 201), "secret");
            String endpoint = JsonUtil.stringField(put(base, "{\"enabled\":true,\"port\":" + port() + "}", 200), "endpoint");
            String body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"execute_query\",\"arguments\":{\"connectionId\":\"sdk-fixture\",\"sql\":\"UPDATE fixture SET x=2\"}}}";
            var query = LocalAuthTest.CLIENT.sendAsync(rpc(endpoint, "Bearer " + secret, body).build(), HttpResponse.BodyHandlers.ofString());
            LocalEngineProcessTest.awaitFile(f.resolve("jdbc-entered"), child.process);
            child.process.getOutputStream().close();
            LocalEngineProcessTest.awaitFile(f.resolve("mcp-interrupted"), child.process);
            absent(endpoint);
            try (LocalEngineProcessTest.Child contender = LocalEngineProcessTest.launch(f, LocalEngineProcessTest.normalArgs(f), 1)) { contender.write(LocalEngineProcessTest.BOOT); contender.failure(15); }
            check(child.process.isAlive(), "EOF retains workspace lock for uncooperative MCP JDBC worker");
            Files.writeString(f.resolve("jdbc-release"), "release", StandardOpenOption.CREATE_NEW);
            child.finish(0, 15);
            try { query.get(10, TimeUnit.SECONDS); } catch (ExecutionException expected) { }
            check(Files.readAllLines(f.resolve("jdbc-entered")).size() == 1, "EOF unknown MCP write never retried");
            try (LocalWorkspace ignored = LocalWorkspace.open(f.resolve("data"), KEY)) { assertions++; }
        }
        check(LocalEngineProcessTest.processes == 6, "Six actual JVMs cover restart/conflict/corruption/EOF/locked contender");
    }
    public static java.sql.Connection childJdbc() throws java.sql.SQLException {
        Path f = Path.of(System.getProperty("gridbase.fixture.jdbc"));
        var statement = (java.sql.Statement) java.lang.reflect.Proxy.newProxyInstance(LocalMcpTest.class.getClassLoader(), new Class[]{java.sql.Statement.class}, (p, m, a) -> {
            switch (m.getName()) {
                case "execute":
                    Files.writeString(f.resolve("jdbc-entered"), "execute\n", StandardOpenOption.CREATE, StandardOpenOption.APPEND);
                    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
                    while (!Files.exists(f.resolve("jdbc-release"))) {
                        if (System.nanoTime() > deadline) throw new java.sql.SQLException("Fixture deadline");
                        try { Thread.sleep(10); } catch (InterruptedException ignored) {
                            Files.writeString(f.resolve("mcp-interrupted"), "interrupted", StandardOpenOption.CREATE);
                        }
                    }
                    return false;
                case "getUpdateCount": return 1;
                case "setQueryTimeout", "setMaxRows", "close": return null;
                default: throw new UnsupportedOperationException(m.getName());
            }
        });
        return (java.sql.Connection) java.lang.reflect.Proxy.newProxyInstance(LocalMcpTest.class.getClassLoader(), new Class[]{java.sql.Connection.class}, (p, m, a) -> switch (m.getName()) {
            case "createStatement" -> statement;
            case "setReadOnly", "close" -> null;
            default -> throw new UnsupportedOperationException(m.getName());
        });
    }
    static void sdk(Path root) throws Exception {
        AppConfig config = config(root);
        try (LocalWorkspace ws = LocalWorkspace.open(config.dataDir, KEY)) {
            var stores = new ConnectionWorkspaces(config, ws, profile -> new JdbcService(config, profile, McpSdkTest::fixture));
            try (Control control = new Control(config, stores, ws)) {
                var registry = stores.forOwner(ws.actor()); registry.save("sdk-fixture", ConnectionSettings.fromJson(PROFILE));
                var profile = registry.mcp("sdk-fixture");
                var created = new McpTokenStore(config.dataDir).create(ws.actor(), "sdk", "read_only", 30, List.of(new McpTokenStore.Grant(profile.id(), profile.generation(), true)));
                control.start(); control.set(true, port());
                var builder = new ProcessBuilder("node", "test/mcp-sdk-probe.js");
                builder.environment().put("GRIDBASE_MCP_FIXTURE_URL", control.endpoint()); builder.environment().put("GRIDBASE_MCP_FIXTURE_TOKEN", created.secret());
                builder.inheritIO(); Process child = builder.start();
                if (!child.waitFor(30, TimeUnit.SECONDS)) { child.destroyForcibly(); throw new AssertionError("Actual local SDK timed out"); }
                check(child.exitValue() == 0, "Actual SDK failed against LocalMcpControl");
            }
        }
    }
}
