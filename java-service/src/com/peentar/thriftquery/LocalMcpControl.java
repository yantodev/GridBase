package com.peentar.thriftquery;

import com.google.gson.JsonObject;
import com.sun.net.httpserver.*;
import java.io.IOException;
import java.net.*;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.*;

/** Engine-owned listeners; no state monitor is held while awaiting HTTP/JDBC termination. */
final class LocalMcpControl implements AutoCloseable {
    private final AppConfig config;
    private final ConnectionWorkspaces workspaces;
    private final LocalWorkspace workspace;
    private final McpTokenStore tokens;
    private final AuditStore audit;
    private volatile Listener live;
    // Retain pending and draining listeners, not just the published endpoint.
    private final Set<Listener> owned = new HashSet<>();
    private boolean started, closed, transitioning;

    LocalMcpControl(AppConfig config, ConnectionWorkspaces workspaces, LocalWorkspace workspace, McpTokenStore tokens, AuditStore audit) {
        if (!config.localMode || !config.dataDir.equals(workspace.dataDir())
                || !workspaces.localOwner(new LocalAuth(new byte[32], workspace.actor())))
            throw new IllegalArgumentException("Local MCP requires the engine-owned local workspace.");
        this.config = config; this.workspaces = workspaces; this.workspace = workspace; this.tokens = tokens; this.audit = audit;
    }
    void start() throws IOException {
        beginTransition(true);
        try {
            var settings = workspace.mcpSettings();
            Listener listener = settings.enabled() ? bind(settings.port()) : null;
            synchronized (this) {
                requireOpen();
                if (listener != null) { listener.active = true; live = listener; }
                started = true;
            }
        } finally { endTransition(); }
    }
    boolean enabled() { return live != null; }
    String endpoint() { Listener listener = live; return listener == null ? null : "http://127.0.0.1:" + listener.server.getAddress().getPort() + "/mcp"; }
    private String state() {
        String endpoint = endpoint();
        return "{\"enabled\":" + (endpoint != null) + ",\"endpoint\":" + JsonUtil.quote(endpoint) + "}";
    }
    void setEnabled(boolean enabled, int port) throws IOException {
        LocalWorkspace.validatePort(port);
        beginTransition(false);
        try {
            LocalWorkspace.McpSettings saved;
            try { saved = workspace.mcpSettings(); }
            catch (IOException unsafe) {
                synchronized (this) {
                    Listener listener = live; live = null;
                    if (listener != null) listener.stopAccepting();
                }
                throw unsafe;
            }
            Listener old;
            synchronized (this) {
                requireOpen(); old = live;
                if (saved.enabled() == enabled && saved.port() == port && (enabled == (old != null))) return;
            }
            // Reserve first: a conflict preserves the prior working listener/settings.
            Listener candidate = enabled ? bind(port) : null;
            synchronized (this) {
                requireOpen(); live = null;
                if (old != null) old.stopAccepting();
            }
            try {
                workspace.saveMcpSettings(enabled, port); // Atomic replace/readback; close waits for this transition.
            } catch (IOException failure) {
                if (candidate != null) candidate.stopAccepting();
                throw failure;
            }
            // The transition remains serialized, but its monitor is NOT held during drain.
            // close can stop every owned candidate immediately, even with uncooperative JDBC.
            if (old != null) drain(old);
            synchronized (this) {
                requireOpen(); // EOF/close must never resurrect the pending candidate.
                if (candidate != null) { candidate.active = true; live = candidate; }
            }
        } finally { endTransition(); }
    }
    private synchronized void beginTransition(boolean starting) throws IOException {
        while (transitioning && !closed) {
            try { wait(); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException("Local MCP transition interrupted."); }
        }
        requireOpen();
        if (starting == started) throw new IllegalStateException("Local MCP control is not in the requested lifecycle state.");
        transitioning = true;
    }
    private void endTransition() {
        try {
            List<Listener> stopped;
            synchronized (this) { stopped = owned.stream().filter(listener -> listener.stopped).toList(); }
            for (Listener listener : stopped) drain(listener);
        } finally {
            synchronized (this) { transitioning = false; notifyAll(); }
        }
    }
    private void drain(Listener listener) {
        listener.awaitFinished();
        synchronized (this) { owned.remove(listener); }
    }
    private void requireOpen() throws IOException {
        if (closed) throw new IOException("Local MCP control is stopping or stopped.");
    }
    void handle(HttpExchange exchange) throws IOException {
        if (!exchange.getRequestURI().getRawPath().equals("/api/local/mcp")) { error(exchange, 404, "NOT_FOUND", "Endpoint not found."); return; }
        if (exchange.getRequestURI().getRawQuery() != null) { error(exchange, 400, "INVALID_SETTINGS", "Query string is not allowed."); return; }
        String method = exchange.getRequestMethod();
        if (method.equals("GET")) { ThriftQueryServer.sendJson(exchange, 200, state()); return; }
        if (!method.equals("PUT")) { exchange.getResponseHeaders().set("Allow", "GET, PUT"); error(exchange, 405, "METHOD_NOT_ALLOWED", "Use GET or PUT."); return; }
        JsonObject body = StrictJson.object(ThriftQueryServer.readBody(exchange));
        if (!body.keySet().equals(Set.of("enabled", "port")) || !body.get("enabled").isJsonPrimitive()
                || !body.get("enabled").getAsJsonPrimitive().isBoolean() || !body.get("port").isJsonPrimitive()
                || !body.get("port").getAsJsonPrimitive().isNumber() || !body.get("port").toString().matches("[1-9][0-9]{0,4}")) throw new IllegalArgumentException();
        try { setEnabled(body.get("enabled").getAsBoolean(), body.get("port").getAsInt()); }
        catch (PortInUse conflict) { error(exchange, 409, "MCP_PORT_IN_USE", conflict.getMessage()); return; }
        catch (IOException unsafe) { error(exchange, 503, "MCP_SETTINGS_UNAVAILABLE", "Local MCP stopped safely. Check authenticated settings, key and private permissions before enabling again."); return; }
        ThriftQueryServer.sendJson(exchange, 200, state());
    }
    @Override public void close() {
        List<Listener> listeners;
        synchronized (this) {
            closed = true; live = null;
            listeners = List.copyOf(owned);
            for (Listener listener : listeners) listener.stopAccepting();
            notifyAll();
        }
        // Repeated/concurrent close calls also wait: no caller may release the workspace early.
        for (Listener listener : listeners) drain(listener);
        boolean interrupted = false;
        synchronized (this) {
            while (transitioning) {
                try { wait(); }
                catch (InterruptedException interruption) { interrupted = true; }
            }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }
    private synchronized Listener bind(int port) throws IOException {
        requireOpen();
        HttpServer server;
        try { server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0); }
        catch (BindException conflict) { throw new PortInUse(); }
        Listener listener;
        try { listener = new Listener(server); }
        catch (RuntimeException failure) { server.stop(0); throw new IOException("Local MCP listener could not be constructed."); }
        owned.add(listener); // Registration precedes start; close cannot miss a bound candidate.
        try {
            server.createContext("/", exchange -> {
                if (!listener.active) { try { error(exchange, 503, "MCP_TRANSITION", "Local MCP is not accepting requests."); } finally { exchange.close(); } }
                else listener.mcp.handle(exchange);
            });
            server.setExecutor(listener.http);
            server.start(); // Published only after actual start, never merely successful socket creation.
            return listener;
        } catch (RuntimeException failure) { listener.stopAccepting(); throw new IOException("Local MCP could not start. Check the requested loopback port."); }
    }
    private final class Listener {
        final HttpServer server;
        final ExecutorService http = Executors.newFixedThreadPool(8);
        final McpServer mcp = new McpServer(config, workspaces, tokens, audit, true);
        volatile boolean active;
        volatile boolean stopped;
        Listener(HttpServer server) { this.server = server; }
        synchronized void stopAccepting() {
            if (stopped) return;
            stopped = true; active = false;
            server.stop(0); http.shutdownNow(); mcp.close();
        }
        void awaitFinished() {
            mcp.awaitLocalWorkers();
            boolean interrupted = false;
            while (!http.isTerminated()) try { http.awaitTermination(1, TimeUnit.SECONDS); } catch (InterruptedException ignored) { interrupted = true; }
            if (interrupted) Thread.currentThread().interrupt();
        }
    }
    static final class PortInUse extends IOException {
        PortInUse() { super("Requested local MCP port is in use. Choose another port in Settings or close the owning application; GridBase did not attach to it."); }
    }
    private static void error(HttpExchange exchange, int status, String code, String message) throws IOException {
        ThriftQueryServer.sendJson(exchange, status, "{\"error\":" + JsonUtil.quote(message) + ",\"code\":" + JsonUtil.quote(code) + "}");
    }
}
