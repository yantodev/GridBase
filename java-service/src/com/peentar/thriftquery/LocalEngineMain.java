package com.peentar.thriftquery;

import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Only explicit packaged-local entry point. Secrets arrive on stdin, never process settings. */
public final class LocalEngineMain {
    // Wire bound includes the terminating LF (CR, if present, also counts).
    private static final int MAX_BOOTSTRAP_BYTES = 8192;
    private static final int BOOTSTRAP_TIMEOUT_SECONDS = 10;
    private LocalEngineMain() { }

    public static void main(String[] args) {
        PrintStream readiness = System.out, diagnostics = System.err;
        // These channels belong to the host protocol, not dependency loggers. Keep
        // third-party startup/JDBC output off both channels in this entry point only.
        System.setOut(new PrintStream(OutputStream.nullOutputStream()));
        System.setErr(new PrintStream(OutputStream.nullOutputStream()));
        int status = 1;
        try { status = run(args, System.in, readiness); }
        catch (Throwable failure) { /* Never expose args, paths, bootstrap or exception messages. */ }
        if (status != 0) diagnostics.println("Local engine stopped safely.");
        System.exit(status);
    }

    private static int run(String[] args, InputStream input, PrintStream output) throws Exception {
        Map<String, Path> paths = arguments(args);
        StdinLifetime stdin = new StdinLifetime(input);
        Bootstrap bootstrap = stdin.bootstrap.get(BOOTSTRAP_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        stdin.requireLive();
        AppConfig config = AppConfig.local(paths.get("--resources"), paths.get("--data-dir"), paths.get("--temp-dir"), bootstrap.clientKind);
        String version = version(paths.get("--resources"));
        PrivateFiles.createDirectory(config.tempDir);
        // SQLite caches its native extraction directory: set both before its first load.
        System.setProperty("java.io.tmpdir", config.tempDir.toString());
        System.setProperty("org.sqlite.tmpdir", config.tempDir.toString());
        try (LocalWorkspace workspace = LocalWorkspace.open(config.dataDir, bootstrap.key)) {
            stdin.requireLive();
            ConnectionWorkspaces workspaces = new ConnectionWorkspaces(config, workspace);
            ThriftQueryServer application = new ThriftQueryServer(config, workspaces, new LocalAuth(bootstrap.capability, workspace.actor()));
            Thread hook = new Thread(application::stop, "local-engine-shutdown");
            Runtime.getRuntime().addShutdownHook(hook);
            try {
                stdin.requireLive();
                application.start(0);
                synchronized (stdin) {
                    stdin.requireLive();
                    output.println("{\"event\":\"ready\",\"protocol\":1,\"version\":" + JsonUtil.quote(version)
                            + ",\"pid\":" + ProcessHandle.current().pid() + ",\"port\":" + application.port() + "}");
                    output.flush();
                    if (output.checkError()) throw new IOException();
                }
                return stdin.terminal.get() == Terminal.EOF ? 0 : 1;
            } finally {
                application.stop(); // All HTTP/request executors end before workspace lock release.
                Runtime.getRuntime().removeShutdownHook(hook);
            }
        }
    }

    private static Map<String, Path> arguments(String[] args) {
        Set<String> names = Set.of("--resources", "--data-dir", "--temp-dir");
        if (args.length != 6) throw new IllegalArgumentException();
        Map<String, Path> paths = new HashMap<>();
        for (int i = 0; i < args.length; i += 2) {
            if (!names.contains(args[i]) || paths.containsKey(args[i])) throw new IllegalArgumentException();
            Path path = Path.of(args[i + 1]);
            if (!path.isAbsolute()) throw new IllegalArgumentException();
            paths.put(args[i], path.normalize());
        }
        return paths;
    }
    private static String version(Path resources) throws IOException {
        Path file = resources.resolve("VERSION");
        PrivateFiles.checkPath(file);
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) throw new IOException();
        ByteBuffer bytes = ByteBuffer.allocate(129);
        try (var channel = java.nio.channels.FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            while (bytes.hasRemaining() && channel.read(bytes) != -1) { }
        }
        if (bytes.position() > 128) throw new IOException();
        bytes.flip();
        String text = StandardCharsets.UTF_8.newDecoder().decode(bytes).toString();
        if (!text.matches("(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?(?:\\r?\\n)?")) throw new IOException();
        return text.stripTrailing();
    }
    private static final class Bootstrap {
        final byte[] capability;
        final CredentialKey key;
        final String clientKind;
        Bootstrap(byte[] line) throws IOException {
            var object = StrictJson.object(StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(line)).toString());
            if (!object.keySet().equals(Set.of("protocol", "capability", "credentialKey", "clientKind"))
                    || !object.get("protocol").toString().equals("1")) throw new IllegalArgumentException();
            capability = LocalAuth.decodeSecret(StrictJson.string(object, "capability", 43));
            key = new CredentialKey(LocalAuth.decodeSecret(StrictJson.string(object, "credentialKey", 43)));
            clientKind = StrictJson.string(object, "clientKind", 7);
            if (!Set.of("desktop", "vscode").contains(clientKind)) throw new IllegalArgumentException();
        }
        @Override public String toString() { return "Bootstrap[REDACTED]"; }
    }
    private enum Terminal { EOF, INVALID }
    private static final class StdinLifetime {
        final CompletableFuture<Bootstrap> bootstrap = new CompletableFuture<>();
        final CompletableFuture<Terminal> terminal = new CompletableFuture<>();
        StdinLifetime(InputStream input) {
            Thread reader = new Thread(() -> {
                try {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    boolean complete = false;
                    for (int count = 0; count < MAX_BOOTSTRAP_BYTES; count++) {
                        int next = input.read();
                        if (next == -1) throw new IOException();
                        if (next == '\n') { complete = true; break; }
                        bytes.write(next);
                    }
                    if (!complete) throw new IOException();
                    Bootstrap parsed = new Bootstrap(bytes.toByteArray());
                    bootstrap.complete(parsed);
                    int next = input.read(); // Keep the owning host's pipe as the lifetime authority.
                    synchronized (this) { terminal.complete(next == -1 ? Terminal.EOF : Terminal.INVALID); }
                } catch (Throwable failure) {
                    bootstrap.completeExceptionally(new IOException("Invalid local bootstrap."));
                    synchronized (this) { terminal.complete(Terminal.INVALID); }
                }
            }, "local-engine-stdin");
            reader.setDaemon(true);
            reader.start();
        }
        synchronized void requireLive() throws IOException { if (terminal.isDone()) throw new IOException(); }
    }
}
