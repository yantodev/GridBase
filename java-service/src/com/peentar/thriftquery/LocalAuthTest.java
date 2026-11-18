package com.peentar.thriftquery;

import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.net.http.*;
import java.time.Duration;
import java.util.*;

/** Real HTTP authorization boundary; no database, browser or external service. */
public final class LocalAuthTest {
    static final String CAP = Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]);
    static final Actor OWNER = Actor.local("11111111-2222-4333-8444-555555555555", "Local");
    static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

    // Reflection keeps the pre-implementation RED an assertion, not a compiler error.
    static RequestAuth auth() throws Exception {
        try {
            return (RequestAuth) Class.forName("com.peentar.thriftquery.LocalAuth")
                    .getDeclaredConstructor(byte[].class, Actor.class).newInstance(new byte[32], OWNER);
        } catch (ClassNotFoundException missing) { throw new AssertionError("Local capability authentication is not implemented", missing); }
    }
    public static void main(String[] args) throws Exception {
        RequestAuth auth = auth();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            try {
                if (auth.handle(exchange, Set.of())) return;
                Actor actor = auth.actor(exchange);
                ThriftQueryServer.sendJson(exchange, 200, "{\"owner\":" + JsonUtil.quote(actor.ownerKey()) + "}");
            } finally { exchange.close(); }
        });
        server.start();
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        try {
            for (String header : List.of("", "Bearer " + CAP, "gridbase-local " + CAP, "GridBase-Local bad", "GridBase-Local " + CAP + "=", "GridBase-Local " + CAP + " extra", "GridBase-Local " + CAP + ",GridBase-Local " + CAP,
                    "GridBase-Local " + CAP.substring(0, 42) + "B", "GridBase-Local " + Base64.getUrlEncoder().withoutPadding().encodeToString(LocalEngineProcessTest.keyBytes()))) {
                var builder = request(base, "/api/connections");
                if (!header.isEmpty()) builder.header("Authorization", header);
                expect(builder, 401);
            }
            expect(request(base, "/api/connections").header("Authorization", "GridBase-Local " + CAP)
                    .header("Authorization", "GridBase-Local " + CAP), 401);
            for (String origin : List.of("", "null", base, "https://example.invalid"))
                expect(valid(base, "/api/connections").header("Origin", origin), 401);
            expect(request(base, "/api/connections?capability=" + CAP).header("Cookie", "gridbase_session=1001").header("X-GridBase-Account", CAP), 401);
            String session = expect(valid(base, "/api/auth/session"), 200).body();
            check(session.contains("\"mode\":\"local\"") && session.contains(OWNER.ownerKey())
                    && session.contains("\"mcpEnabled\":false") && session.contains("\"auditAdmin\":false"), "Trusted local session");
            expect(valid(base, "/healthz"), 200);
            check(expect(valid(base, "/api/connections").header("X-GridBase-Account", "1001"), 200).body().contains(OWNER.ownerKey()), "Attribution headers cannot select an owner");
            for (String path : List.of("/api/local/mcp", "/api/mcp/tokens", "/api/mcp/tokens/11111111-1111-4111-8111-111111111111")) {
                expect(request(base, path), 401);
                check(expect(valid(base, path).header("X-GridBase-Account", "1001"), 200).body().contains(OWNER.ownerKey()), "Management remains capability-only and manifest-owned");
            }
            for (String path : List.of("/", "/index.html", "/login", "/auth/github", "/auth/github/callback", "/auth/logout", "/mcp", "/mcp.js")) {
                expect(request(base, path), 401);
                expect(valid(base, path), 404);
            }
        } finally { server.stop(0); }
        // Deliberately unsafe fixture bind verifies LocalAuth independently of
        // the production engine's mandatory 127.0.0.1 bind guard.
        InetAddress nonLoopback = NetworkInterface.networkInterfaces().flatMap(NetworkInterface::inetAddresses)
                .filter(a -> a instanceof Inet4Address && !a.isLoopbackAddress() && !a.isAnyLocalAddress()).findFirst().orElseThrow();
        HttpServer unsafeFixture = HttpServer.create(new InetSocketAddress("0.0.0.0", 0), 0);
        unsafeFixture.createContext("/", exchange -> {
            try {
                if (!auth.handle(exchange, Set.of())) ThriftQueryServer.sendJson(exchange, 200, "{}");
            } finally { exchange.close(); }
        });
        unsafeFixture.start();
        try { expect(valid("http://" + nonLoopback.getHostAddress() + ":" + unsafeFixture.getAddress().getPort(), "/api/connections"), 401); }
        finally { unsafeFixture.stop(0); }
        System.out.println("Local auth tests passed (real HTTP: strict capability, Origin/nonloopback denial, management/session, disabled browser/OAuth/MCP transport)");
    }
    static HttpRequest.Builder request(String base, String path) {
        return HttpRequest.newBuilder(URI.create(base + path)).timeout(Duration.ofSeconds(5)).GET();
    }
    static HttpRequest.Builder valid(String base, String path) { return request(base, path).header("Authorization", "GridBase-Local " + CAP); }
    static HttpResponse<String> expect(HttpRequest.Builder builder, int status) throws Exception {
        var response = CLIENT.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        check(response.statusCode() == status, builder.build().uri().getPath() + " expected " + status + ", got " + response.statusCode());
        check(response.headers().firstValue("Content-Type").orElse("").startsWith("application/json"), "Typed JSON response");
        StrictJson.object(response.body());
        check(response.headers().firstValue("Access-Control-Allow-Origin").isEmpty(), "No CORS permissions");
        check(!response.body().contains(CAP), "No capability in responses");
        if (status >= 400) check(StrictJson.object(response.body()).has("error"), "Typed JSON error");
        return response;
    }
    static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
