package com.peentar.thriftquery;

import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/** GitHub tokens stay on the server and are discarded after identity verification. */
final class GitHubAuth {
    private static final String SESSION_COOKIE = "gridbase_session";
    private static final String STATE_COOKIE = "gridbase_oauth";
    private static final long SESSION_SECONDS = 8 * 60 * 60;
    private static final long STATE_SECONDS = 10 * 60;
    private static final Set<String> PUBLIC_FILES = Set.of("/login", "/login.html", "/login.js", "/styles.css");
    private static final SecureRandom RANDOM = new SecureRandom();
    private final AuthConfig config;
    private final IdentityProvider provider;
    private final LongSupplier clock;
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();

    @FunctionalInterface
    interface IdentityProvider { String login(String code, String verifier) throws Exception; }
    private record Pending(String verifier, long expiresAt) {}
    private record Session(String login, long expiresAt) {}

    GitHubAuth(AuthConfig config) { this(config, new GitHubProvider(config), System::currentTimeMillis); }
    GitHubAuth(AuthConfig config, IdentityProvider provider) { this(config, provider, System::currentTimeMillis); }
    GitHubAuth(AuthConfig config, IdentityProvider provider, LongSupplier clock) {
        this.config = config;
        this.provider = provider;
        this.clock = clock;
    }

    /** Returns true when the request was fully handled, false when the protected handler may run. */
    boolean handle(HttpExchange exchange) throws IOException {
        long now = clock.getAsLong();
        pending.entrySet().removeIf(entry -> entry.getValue().expiresAt() <= now);
        sessions.entrySet().removeIf(entry -> entry.getValue().expiresAt() <= now);
        String path = exchange.getRequestURI().getPath();
        String method = exchange.getRequestMethod();
        Session session = sessions.get(cookie(exchange, SESSION_COOKIE));
        if (path.equals("/healthz") && method.equals("GET")) {
            json(exchange, 200, "{\"status\":\"ok\"}"); return true;
        }
        if (path.equals("/auth/github")) {
            if (!method.equals("GET")) return methodNotAllowed(exchange, "GET");
            if (session != null) { redirect(exchange, "/"); return true; }
            if (!config.configured()) { redirect(exchange, "/login?error=not_configured"); return true; }
            if (pending.size() >= 1000) { redirect(exchange, "/login?error=busy"); return true; }
            String state = randomToken(), verifier = randomToken();
            pending.put(state, new Pending(verifier, now + STATE_SECONDS * 1000));
            setCookie(exchange, STATE_COOKIE, state, "/auth/github", STATE_SECONDS);
            redirect(exchange, "https://github.com/login/oauth/authorize?client_id=" + encode(config.clientId())
                    + "&redirect_uri=" + encode(config.callbackUrl()) + "&state=" + encode(state)
                    + "&code_challenge=" + challenge(verifier) + "&code_challenge_method=S256");
            return true;
        }
        if (path.equals("/auth/github/callback")) {
            if (!method.equals("GET")) return methodNotAllowed(exchange, "GET");
            callback(exchange, now); return true;
        }
        if (path.equals("/api/auth/session")) {
            if (!method.equals("GET")) return methodNotAllowed(exchange, "GET");
            json(exchange, 200, "{\"authenticated\":" + (session != null) + ",\"configured\":" + config.configured()
                    + ",\"user\":" + (session == null ? "null" : "{\"login\":" + JsonUtil.quote(session.login()) + "}") + "}");
            return true;
        }
        if (PUBLIC_FILES.contains(path) && method.equals("GET")) {
            if (session != null && (path.equals("/login") || path.equals("/login.html"))) {
                redirect(exchange, "/"); return true;
            }
            return false;
        }
        if (session == null) {
            if (path.startsWith("/api/") || path.equals("/auth/logout")) json(exchange, 401, "{\"error\":\"Silakan login dengan GitHub.\"}");
            else redirect(exchange, "/login");
            return true;
        }
        if (!method.equals("GET") && !method.equals("HEAD")) {
            String origin = exchange.getRequestHeaders().getFirst("Origin");
            String site = exchange.getRequestHeaders().getFirst("Sec-Fetch-Site");
            String type = exchange.getRequestHeaders().getFirst("Content-Type");
            if ((origin != null && !origin.equals(config.appUrl())) || "cross-site".equals(site)
                    || (method.equals("POST") && (type == null || !type.split(";", 2)[0].trim().equalsIgnoreCase("application/json")))) {
                json(exchange, 403, "{\"error\":\"Asal request tidak diizinkan.\"}"); return true;
            }
        }
        if (path.equals("/auth/logout")) {
            if (!method.equals("POST")) return methodNotAllowed(exchange, "POST");
            sessions.remove(cookie(exchange, SESSION_COOKIE));
            setCookie(exchange, SESSION_COOKIE, "", "/", 0);
            json(exchange, 200, "{\"ok\":true}"); return true;
        }
        return false;
    }

    private void callback(HttpExchange exchange, long now) throws IOException {
        setCookie(exchange, STATE_COOKIE, "", "/auth/github", 0);
        Map<String, String> params;
        try { params = params(exchange.getRequestURI().getRawQuery()); }
        catch (IllegalArgumentException invalid) { redirect(exchange, "/login?error=invalid_state"); return; }
        String state = params.getOrDefault("state", "");
        String browserState = cookie(exchange, STATE_COOKIE);
        if (state.isEmpty() || !MessageDigest.isEqual(state.getBytes(StandardCharsets.UTF_8), browserState.getBytes(StandardCharsets.UTF_8))) {
            redirect(exchange, "/login?error=invalid_state"); return;
        }
        Pending attempt = pending.remove(state);
        if (attempt == null || attempt.expiresAt() <= now) { redirect(exchange, "/login?error=invalid_state"); return; }
        if (params.containsKey("error")) { redirect(exchange, "/login?error=denied"); return; }
        String code = params.getOrDefault("code", "");
        if (!config.configured() || code.isBlank() || code.length() > 2048) { redirect(exchange, "/login?error=failed"); return; }
        try {
            String login = provider.login(code, attempt.verifier());
            if (login == null || !login.matches("[A-Za-z0-9-]{1,39}")) throw new IllegalArgumentException("Invalid GitHub login");
            if (!config.allowedUsers().isEmpty() && !config.allowedUsers().contains(login.toLowerCase(Locale.ROOT))) {
                redirect(exchange, "/login?error=not_allowed"); return;
            }
            if (sessions.size() >= 10000) { redirect(exchange, "/login?error=busy"); return; }
            sessions.remove(cookie(exchange, SESSION_COOKIE));
            String token = randomToken();
            sessions.put(token, new Session(login, clock.getAsLong() + SESSION_SECONDS * 1000));
            setCookie(exchange, SESSION_COOKIE, token, "/", SESSION_SECONDS);
            redirect(exchange, "/");
        } catch (Exception failure) {
            if (failure instanceof InterruptedException) Thread.currentThread().interrupt();
            // Never log the provider response, client secret, authorization code, or access token.
            System.err.println("GitHub login failed: " + failure.getClass().getSimpleName());
            redirect(exchange, "/login?error=failed");
        }
    }

    private void setCookie(HttpExchange exchange, String name, String value, String path, long maxAge) {
        exchange.getResponseHeaders().add("Set-Cookie", name + "=" + value + "; Path=" + path + "; Max-Age=" + maxAge
                + "; HttpOnly; SameSite=Lax" + (config.secure() ? "; Secure" : ""));
    }

    private static String cookie(HttpExchange exchange, String name) {
        for (String header : exchange.getRequestHeaders().getOrDefault("Cookie", java.util.List.of())) {
            for (String pair : header.split(";")) {
                String[] parts = pair.trim().split("=", 2);
                if (parts.length == 2 && parts[0].equals(name)) return parts[1];
            }
        }
        return "";
    }

    static Map<String, String> params(String raw) {
        Map<String, String> result = new HashMap<>();
        if (raw != null) for (String pair : raw.split("&")) {
            String[] parts = pair.split("=", 2);
            String name = URLDecoder.decode(parts[0], StandardCharsets.UTF_8);
            String value = parts.length == 2 ? URLDecoder.decode(parts[1], StandardCharsets.UTF_8) : "";
            if (result.putIfAbsent(name, value) != null) throw new IllegalArgumentException("Duplicate parameter");
        }
        return result;
    }

    static String challenge(String verifier) {
        try { return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private static String randomToken() {
        byte[] bytes = new byte[32]; RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String encode(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }

    private static boolean methodNotAllowed(HttpExchange exchange, String allow) throws IOException {
        exchange.getResponseHeaders().set("Allow", allow);
        json(exchange, 405, "{\"error\":\"Method tidak didukung.\"}"); return true;
    }

    private static void redirect(HttpExchange exchange, String location) throws IOException {
        ThriftQueryServer.applySecurityHeaders(exchange.getResponseHeaders());
        exchange.getResponseHeaders().set("Location", location);
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(303, -1); exchange.close();
    }

    private static void json(HttpExchange exchange, int status, String body) throws IOException {
        ThriftQueryServer.sendJson(exchange, status, body);
    }

    private static final class GitHubProvider implements IdentityProvider {
        private final AuthConfig config;
        private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER).build();
        GitHubProvider(AuthConfig config) { this.config = config; }

        @Override public String login(String code, String verifier) throws Exception {
            String form = "client_id=" + encode(config.clientId()) + "&client_secret=" + encode(config.clientSecret())
                    + "&code=" + encode(code) + "&redirect_uri=" + encode(config.callbackUrl()) + "&code_verifier=" + encode(verifier);
            HttpResponse<String> tokenResponse = client.send(HttpRequest.newBuilder(URI.create("https://github.com/login/oauth/access_token"))
                    .timeout(Duration.ofSeconds(15)).header("Accept", "application/json").header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(form)).build(), HttpResponse.BodyHandlers.ofString());
            if (tokenResponse.statusCode() != 200) throw new IOException("GitHub token exchange failed");
            String token = JsonUtil.stringField(tokenResponse.body(), "access_token");
            if (token.isBlank()) throw new IOException("Missing GitHub access token");
            HttpResponse<String> identity = client.send(HttpRequest.newBuilder(URI.create("https://api.github.com/user"))
                    .timeout(Duration.ofSeconds(15)).header("Accept", "application/vnd.github+json")
                    .header("User-Agent", "GridBase").header("X-GitHub-Api-Version", "2022-11-28")
                    .header("Authorization", "Bearer " + token).GET().build(), HttpResponse.BodyHandlers.ofString());
            if (identity.statusCode() != 200) throw new IOException("GitHub identity request failed");
            return JsonUtil.stringField(identity.body(), "login");
        }
    }
}
