package com.peentar.thriftquery;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import javax.tools.ToolProvider;

/** Deterministic two-JVM regression. Only a disposable source copy contains the scheduling barrier. */
public final class ConnectionStoreKeyRaceTest {
    private static final String SETTINGS = "{\"type\":\"postgresql\",\"name\":\"Race fixture\",\"host\":\"fixture.invalid\",\"database\":\"fixture\",\"username\":\"fixture\",\"password\":\"race-fixture-secret\"}";
    public static void main(String[] args) throws Exception {
        if (args.length != 0) { worker(Path.of(args[0]), args[1]); return; }
        Path root = Files.createTempDirectory("gridbase-key-race-空 間");
        try {
            PrivateFiles.createDirectory(root); // Existing fixture only; never change shared scratch policy.
            Path classes = instrumentDisposableCopy(root);
            controlledWinnerRace(root.resolve("winner-race"), classes);
            controlledIncompleteRace(root.resolve("incomplete-race"), classes);
            for (int size : List.of(0, 1, 16, 31, 33)) {
                Path data = root.resolve("incomplete-" + size); PrivateFiles.createDirectory(data);
                byte[] fixture = new byte[size]; Arrays.fill(fixture, (byte) 19);
                Files.write(data.resolve("credentials.key"), fixture);
                expectFailure(() -> new ConnectionStore(data, "1001"));
                check(Arrays.equals(fixture, Files.readAllBytes(data.resolve("credentials.key"))), "incomplete key preserved");
                check(!Files.exists(data.resolve("gridbase.sqlite")), "incomplete key must not create database");
            }
            System.out.println("Server key race: controlled two-JVM winner/loser preserved key and reopened/decrypted SQLite; raced/incomplete keys fail closed");
        } finally { PrivateFilesTest.remove(root); }
    }

    private static Path instrumentDisposableCopy(Path root) throws Exception {
        Path source = Path.of("java-service/src/com/peentar/thriftquery/ConnectionStore.java");
        String text = Files.readString(source);
        String anchor = "RANDOM.nextBytes(generated);";
        check(text.indexOf(anchor) >= 0 && text.indexOf(anchor) == text.lastIndexOf(anchor), "unique server key-creation scheduling point");
        text = text.replace(anchor, anchor + "\n                        ConnectionStoreKeyRaceTest.awaitKeyCreation();");
        Path copy = root.resolve("instrumented-source/ConnectionStore.java"); Files.createDirectories(copy.getParent()); Files.writeString(copy, text);
        Path classes = root.resolve("instrumented-classes"); Files.createDirectory(classes);
        var compiler = ToolProvider.getSystemJavaCompiler(); check(compiler != null, "JDK compiler required");
        int status = compiler.run(null, System.out, System.err, "--release", "17", "-cp", System.getProperty("java.class.path"), "-d", classes.toString(), copy.toString());
        check(status == 0, "disposable instrumented ConnectionStore compiled");
        return classes;
    }

    // Called ONLY by the disposable source copy, never from the repository's production class.
    public static void awaitKeyCreation() throws Exception {
        Path barrier = Path.of(System.getProperty("gridbase.fixture.barrier"));
        String worker = System.getProperty("gridbase.fixture.worker");
        Files.writeString(barrier.resolve(worker + ".ready"), "ready", StandardOpenOption.CREATE_NEW);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (!Files.exists(barrier.resolve(worker + ".go"))) {
            if (System.nanoTime() > deadline) throw new AssertionError("fixture barrier timed out");
            Thread.sleep(10);
        }
    }
    private static void controlledWinnerRace(Path root, Path classes) throws Exception {
        Files.createDirectory(root); Path data = root.resolve("data"); Path barrier = root.resolve("barrier"); Files.createDirectory(barrier);
        Process winner = start(data, barrier, "winner", classes), loser = start(data, barrier, "loser", classes);
        try {
            awaitReady(barrier, "winner", winner); awaitReady(barrier, "loser", loser);
            release(barrier, "winner"); completed(winner, 0);
            byte[] established = Files.readAllBytes(data.resolve("credentials.key")); check(established.length == 32, "winner persisted valid fixture key");
            release(barrier, "loser");
            int loserStatus = finish(loser);
            check(Arrays.equals(established, Files.readAllBytes(data.resolve("credentials.key"))), "losing server JVM must not overwrite established credentials.key");
            check(loserStatus == 23, "racing key creator fails closed");
            check(new ConnectionStore(data, "1001").load().get("winner").profile().password().equals("race-fixture-secret"), "winner ciphertext decrypts after loser/reopen");
            System.out.println("Two JVMs paused after absent-key checks; winner saved SQLite, loser refused, key unchanged, winner reopened/decrypted");
        } finally { terminate(winner); terminate(loser); }
    }
    private static void controlledIncompleteRace(Path root, Path classes) throws Exception {
        Files.createDirectory(root); Path data = root.resolve("data"); Path barrier = root.resolve("barrier"); Files.createDirectory(barrier);
        Process contender = start(data, barrier, "incomplete", classes);
        try {
            awaitReady(barrier, "incomplete", contender);
            Files.createFile(data.resolve("credentials.key")); // A competing creator published an incomplete file.
            release(barrier, "incomplete"); int status = finish(contender);
            check(Files.size(data.resolve("credentials.key")) == 0, "raced incomplete key must not be overwritten");
            check(status == 23 && !Files.exists(data.resolve("gridbase.sqlite")), "raced incomplete key fails closed without database");
            System.out.println("Raced incomplete fixture key preserved without database creation");
        } finally { terminate(contender); }
    }
    private static void worker(Path data, String role) {
        try {
            var store = new ConnectionStore(data, "1001");
            if (role.equals("winner")) store.save("winner", ConnectionSettings.fromJson(SETTINGS));
            System.out.println("WORKER_INITIALIZED");
        } catch (ConnectionStore.StoreException expected) { System.out.println("WORKER_REFUSED"); System.exit(23); }
    }
    private static Process start(Path data, Path barrier, String worker, Path classes) throws Exception {
        String cp = classes + java.io.File.pathSeparator + System.getProperty("java.class.path");
        return new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-ea", "-Dgridbase.fixture.barrier=" + barrier,
                "-Dgridbase.fixture.worker=" + worker, "-cp", cp, ConnectionStoreKeyRaceTest.class.getName(), data.toString(), worker).redirectErrorStream(true).start();
    }
    private static void awaitReady(Path barrier, String name, Process process) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (!Files.exists(barrier.resolve(name + ".ready"))) {
            check(process.isAlive(), "fixture worker exited before barrier");
            if (System.nanoTime() > deadline) throw new AssertionError("fixture worker did not reach barrier");
            Thread.sleep(10);
        }
    }
    private static void release(Path barrier, String name) throws Exception { Files.writeString(barrier.resolve(name + ".go"), "go", StandardOpenOption.CREATE_NEW); }
    private static int finish(Process process) throws Exception {
        if (!process.waitFor(30, TimeUnit.SECONDS)) throw new AssertionError("fixture worker timed out");
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        check(output.contains("WORKER_INITIALIZED") || output.contains("WORKER_REFUSED"), "real worker completed: " + output);
        return process.exitValue();
    }
    private static void completed(Process process, int status) throws Exception { check(finish(process) == status, "fixture worker exit status"); }
    private static void terminate(Process process) throws Exception { if (process.isAlive()) { process.destroyForcibly(); process.waitFor(10, TimeUnit.SECONDS); } }
    private static void expectFailure(Runnable action) { try { action.run(); throw new AssertionError("incomplete key accepted"); } catch (ConnectionStore.StoreException expected) { } }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
