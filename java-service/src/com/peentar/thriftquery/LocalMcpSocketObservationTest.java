package com.peentar.thriftquery;

import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Injected observation outcomes, not claims of native TCP reset reproduction. */
public final class LocalMcpSocketObservationTest {
    private static final String ENDPOINT = "http://127.0.0.1:12345/mcp";
    private static final long BUDGET = TimeUnit.MILLISECONDS.toNanos(100);
    private static int cases;

    public static void main(String[] args) throws Exception {
        // Initialize the shared assertion fixture before starting any short probe deadline.
        LocalAuthTest.check(true, "Observation fixture initialized");
        for (boolean afterExit : List.of(false, true)) {
            resetThenRefusal(afterExit);
            resetThenAccepting(afterExit);
            permanentDenial(afterExit);
            otherConnectException(afterExit);
            permanentResets(afterExit);
            genericIoFailure(afterExit);
        }
        processMustRemainAlive();
        System.out.println("Local MCP socket observation passed (" + cases + " injected cases; no business requests or child JVMs)");
    }

    private static void observe(boolean afterExit, LocalMcpRebindEofTest.SocketConnector connector) throws Exception {
        if (afterExit) LocalMcpRebindEofTest.absentAfterExit(ENDPOINT, connector, BUDGET);
        else LocalMcpRebindEofTest.awaitClosed(ENDPOINT, null, "Injected listener did not close", connector, BUDGET);
    }

    private static void resetThenRefusal(boolean afterExit) throws Exception {
        List<Socket> sockets = new ArrayList<>();
        observe(afterExit, (socket, address, timeout) -> {
            check(!sockets.contains(socket), "Each observation must use a fresh socket");
            sockets.add(socket);
            if (sockets.size() == 1) throw new SocketException("Connection reset by peer");
            throw new ConnectException("Connection refused");
        });
        check(sockets.size() == 2, "Reset is not closure: an explicit refusal must be observed next");
        check(sockets.stream().allMatch(Socket::isClosed), "Every probe socket is closed");
        passed("injected reset -> explicit refusal", afterExit);
    }

    private static void resetThenAccepting(boolean afterExit) throws Exception {
        int[] attempts = {0};
        long start = System.nanoTime();
        AssertionError failure = expectFailure(() -> observe(afterExit, (socket, address, timeout) -> {
            if (++attempts[0] == 1) throw new SocketException("Connection reset by peer");
            // Injected successful TCP connect: no closure evidence.
        }));
        check(attempts[0] >= 2, "A reset cannot hide a subsequent accepting listener");
        check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 2000, "Accepting listener failure must be bounded");
        check(failure.getMessage().contains(afterExit ? "resurrected" : "Injected listener did not close"), "Accepting failure keeps fixture reason");
        passed("injected reset -> accepting listener fails", afterExit);
    }

    private static void permanentDenial(boolean afterExit) throws Exception {
        SocketException denied = new SocketException("Permission denied");
        int[] attempts = {0};
        AssertionError failure = expectFailure(() -> observe(afterExit, (socket, address, timeout) -> {
            attempts[0]++;
            throw denied;
        }));
        check(attempts[0] == 1, "Permanent denial is not retried as a reset or accepted as closure");
        check(failure.getCause() == denied && failure.getMessage().contains(ENDPOINT)
                && failure.getMessage().contains("closure not proven"), "Denial failure identifies fixture endpoint and preserves cause");
        passed("injected permanent denial fails with context", afterExit);
    }

    private static void otherConnectException(boolean afterExit) throws Exception {
        ConnectException denied = new ConnectException("Permission denied: connect");
        boolean accepted = true;
        AssertionError failure = null;
        try { observe(afterExit, (socket, address, timeout) -> { throw denied; }); }
        catch (AssertionError expected) { accepted = false; failure = expected; }
        check(!accepted, "Non-refusal ConnectException is not evidence of listener closure");
        check(failure.getCause() == denied, "Non-refusal ConnectException cause retained");
        passed("injected non-refusal ConnectException fails", afterExit);
    }

    private static void permanentResets(boolean afterExit) throws Exception {
        SocketException reset = new SocketException("Connection reset");
        int[] attempts = {0};
        long start = System.nanoTime();
        AssertionError failure = expectFailure(() -> observe(afterExit, (socket, address, timeout) -> {
            attempts[0]++;
            check(timeout > 0 && timeout <= 100, "Each connect is bounded by remaining total budget");
            throw reset;
        }));
        check(attempts[0] > 1, "Classified resets retry observation, not closure success");
        check(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 2000, "Permanent resets have one bounded deadline");
        check(failure.getCause() == reset && failure.getMessage().contains("deadline expired without connection refusal")
                && failure.getMessage().contains("resets="), "Reset timeout preserves useful evidence");
        passed("injected permanent resets time out", afterExit);
    }

    private static void genericIoFailure(boolean afterExit) throws Exception {
        IOException denied = new IOException("fixture I/O unavailable");
        int[] attempts = {0};
        AssertionError failure = expectFailure(() -> observe(afterExit, (socket, address, timeout) -> {
            attempts[0]++;
            throw denied;
        }));
        check(attempts[0] == 1 && failure.getCause() == denied && failure.getMessage().contains(ENDPOINT), "Generic I/O fails immediately with endpoint/cause");
        passed("injected generic I/O fails", afterExit);
    }

    private static void processMustRemainAlive() throws Exception {
        boolean[] alive = {true};
        Process fixture = new Process() {
            public OutputStream getOutputStream() { return OutputStream.nullOutputStream(); }
            public InputStream getInputStream() { return InputStream.nullInputStream(); }
            public InputStream getErrorStream() { return InputStream.nullInputStream(); }
            public int waitFor() { return 0; }
            public int exitValue() { return 0; }
            public void destroy() { alive[0] = false; }
            public boolean isAlive() { return alive[0]; }
        };
        AssertionError failure = expectFailure(() -> LocalMcpRebindEofTest.awaitClosed(ENDPOINT, fixture, "Injected early exit",
                (socket, address, timeout) -> { alive[0] = false; throw new ConnectException("Connection refused"); }, BUDGET));
        check(failure.getMessage().contains("Engine exited before JDBC fixture release"), "Even explicit refusal cannot hide early child death");
        passed("injected early process exit fails", false);
    }

    @FunctionalInterface private interface Action { void run() throws Exception; }
    private static AssertionError expectFailure(Action action) throws Exception {
        try { action.run(); }
        catch (AssertionError expected) { return expected; }
        throw new AssertionError("Observation incorrectly accepted listener closure");
    }

    private static void passed(String name, boolean afterExit) {
        cases++;
        System.out.println("PASS " + name + " [" + (afterExit ? "absentAfterExit" : "awaitClosed") + "]");
    }
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
}
