package com.peentar.thriftquery;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/** Exercises real HTTP requests with a fake identity provider, without GitHub credentials. */
public final class GitHubAuthTest {
    private static final HttpClient CLIENT = HttpClient.newHttpClient();
    record Flow(String cookie, String state, String challenge) {}

    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("gridbase-auth");
        Files.createDirectories(root.resolve("public"));
        Files.writeString(root.resolve("public/login.html"), "login-page");
        Files.writeString(root.resolve("public/index.html"), "protected-workbench");
        AppConfig unconfigured = AppConfig.load(root, Map.of());
        ThriftQueryServer server = new ThriftQueryServer(unconfigured, new ConnectionRegistry(unconfigured));
        try {
            server.start(0);
            String base = "http://127.0.0.1:" + server.port();
            check(get(base, "/", "", 303).headers().firstValue("Location").orElse("").equals("/login"), "Root must require login");
            for (String path : List.of("/index.html", "/%69ndex.html", "/app.js", "/workbench-core.js", "/missing")) {
                check(!get(base, path, "", 303).body().contains("protected-workbench"), "No protected content before login");
            }
            check(get(base, "/login", "", 200).body().equals("login-page"), "Public login page");
            check(get(base, "/healthz", "", 200).body().equals("{\"status\":\"ok\"}"), "Public liveness has no database metadata");
            check(get(base, "/auth/github", "", 303).headers().firstValue("Location").orElse("").contains("not_configured"), "Missing credentials cannot bypass login");
            check(get(base, "/api/auth/session", "", 200).body().contains("\"configured\":false"), "Login configuration status");
            for (String path : List.of("/api/health", "/api/connections", "/api/connections/test", "/api/connections/private", "/api/query", "/api/databases", "/api/namespaces", "/api/tables", "/api/columns")) {
                get(base, path, "", 401);
                send(base, path, "POST", "", "application/json", null, 401);
            }
            server.stop();

            AtomicLong now = new AtomicLong(1_000_000);
            java.util.concurrent.atomic.AtomicReference<String> expectedChallenge = new java.util.concurrent.atomic.AtomicReference<>();
            AppConfig config = AppConfig.load(root, Map.of("GITHUB_CLIENT_ID", "fixture-id", "GITHUB_CLIENT_SECRET", "fixture-secret", "GITHUB_ALLOWED_USERS", "Fixture-User"));
            GitHubAuth auth = new GitHubAuth(config.auth, (code, verifier) -> {
                check(verifier.length() >= 43, "PKCE verifier has sufficient entropy");
                if (expectedChallenge.get() != null) check(GitHubAuth.challenge(verifier).equals(expectedChallenge.get()), "Token exchange verifier must match the authorization challenge");
                if (code.equals("failure")) throw new java.io.IOException("fixture provider failure");
                return code.equals("outsider") ? "outsider" : "fixture-user";
            }, now::get);
            server = new ThriftQueryServer(config, new ConnectionRegistry(config), auth);
            server.start(0); base = "http://127.0.0.1:" + server.port();
            Flow first = begin(base);
            expectedChallenge.set(first.challenge());
            check(first.challenge().length() == 43, "S256 challenge");
            get(base, callback(first.state(), "fixture"), "", 303);
            check(get(base, callback("wrong", "fixture"), first.cookie(), 303).headers().firstValue("Location").orElse("").contains("invalid_state"), "State mismatch denied");
            HttpResponse<String> loggedIn = get(base, callback(first.state(), "fixture"), first.cookie(), 303);
            String session = sessionCookie(loggedIn);
            expectedChallenge.set(null);
            check(loggedIn.headers().firstValue("Location").orElse("").equals("/"), "Successful callback opens workbench");
            String rawCookie = loggedIn.headers().allValues("Set-Cookie").stream().filter(value -> value.startsWith("gridbase_session=")).findFirst().orElseThrow();
            check(rawCookie.contains("HttpOnly") && rawCookie.contains("SameSite=Lax") && rawCookie.contains("Max-Age=28800"), "Session cookie security and lifetime");
            check(get(base, "/", session, 200).body().equals("protected-workbench"), "Valid session opens workbench");
            check(get(base, "/login", session, 303).headers().firstValue("Location").orElse("").equals("/"), "Signed-in user skips login");
            String identity = get(base, "/api/auth/session", session, 200).body();
            check(identity.contains("fixture-user") && !identity.contains("fixture-secret"), "Session exposes only identity");
            get(base, "/api/connections", session, 200);
            check(get(base, callback(first.state(), "fixture"), first.cookie(), 303).headers().firstValue("Location").orElse("").contains("invalid_state"), "Callback cannot be replayed");
            send(base, "/api/query", "POST", session, "application/json", "https://untrusted.example", 403);
            send(base, "/api/query", "POST", session, "text/plain", null, 403);
            send(base, "/api/query", "POST", session, "application/json", config.auth.appUrl(), 400);
            get(base, "/auth/logout", session, 405);
            send(base, "/auth/logout", "POST", session, "application/json", "https://untrusted.example", 403);
            get(base, "/api/connections", session, 200);
            HttpResponse<String> logout = send(base, "/auth/logout", "POST", session, "application/json", config.auth.appUrl(), 200);
            check(logout.headers().allValues("Set-Cookie").stream().anyMatch(value -> value.startsWith("gridbase_session=") && value.contains("Max-Age=0")), "Logout clears cookie");
            get(base, "/api/connections", session, 401);
            get(base, "/api/connections", "gridbase_session=forged", 401);

            for (String code : List.of("failure", "outsider", "")) {
                Flow flow = begin(base);
                HttpResponse<String> rejected = get(base, callback(flow.state(), code), flow.cookie(), 303);
                check(rejected.headers().firstValue("Location").orElse("").contains(code.equals("outsider") ? "not_allowed" : "failed"), "Provider failures and allowlist denied");
                check(rejected.headers().allValues("Set-Cookie").stream().noneMatch(value -> value.startsWith("gridbase_session=")), "Rejected login must not establish a session");
            }
            Flow denied = begin(base);
            check(get(base, "/auth/github/callback?state=" + denied.state() + "&error=access_denied", denied.cookie(), 303).headers().firstValue("Location").orElse("").contains("denied"), "Cancellation handled");
            Flow expired = begin(base); now.addAndGet(600_000);
            check(get(base, callback(expired.state(), "fixture"), expired.cookie(), 303).headers().firstValue("Location").orElse("").contains("invalid_state"), "Expired OAuth state denied");
            String expiringSession = login(base); now.addAndGet(28_800_000);
            get(base, "/api/connections", expiringSession, 401);
            server.stop();

            AppConfig secureConfig = AppConfig.load(root, Map.of("APP_URL", "https://gridbase.example", "GITHUB_CLIENT_ID", "fixture", "GITHUB_CLIENT_SECRET", "fixture"));
            server = new ThriftQueryServer(secureConfig, new ConnectionRegistry(secureConfig), new GitHubAuth(secureConfig.auth, (code, verifier) -> "fixture-user"));
            server.start(0); base = "http://127.0.0.1:" + server.port();
            Flow secureFlow = begin(base);
            check(get(base, callback(secureFlow.state(), "fixture"), secureFlow.cookie(), 303).headers().allValues("Set-Cookie").stream().allMatch(value -> value.contains("; Secure")), "HTTPS sets Secure on OAuth and session cookies");
            System.out.println("GitHub auth HTTP tests passed (fake identity provider)");
        } finally {
            server.stop();
            try (var paths = Files.walk(root)) { for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); }
        }
    }

    static Flow begin(String base) throws Exception {
        HttpResponse<String> response = get(base, "/auth/github", "", 303);
        URI authorization = URI.create(response.headers().firstValue("Location").orElseThrow());
        check(authorization.getHost().equals("github.com"), "Only redirect to GitHub");
        Map<String, String> params = GitHubAuth.params(authorization.getRawQuery());
        check(params.get("code_challenge_method").equals("S256") && !params.containsKey("client_secret"), "Use PKCE without exposing secret");
        String cookie = response.headers().allValues("Set-Cookie").stream().filter(value -> value.startsWith("gridbase_oauth=")).findFirst().orElseThrow().split(";", 2)[0];
        return new Flow(cookie, params.get("state"), params.get("code_challenge"));
    }

    static String login(String base) throws Exception {
        Flow flow = begin(base);
        return sessionCookie(get(base, callback(flow.state(), "fixture"), flow.cookie(), 303));
    }

    private static String callback(String state, String code) { return "/auth/github/callback?state=" + state + "&code=" + code; }
    private static String sessionCookie(HttpResponse<String> response) {
        return response.headers().allValues("Set-Cookie").stream().filter(value -> value.startsWith("gridbase_session=")).findFirst().orElseThrow().split(";", 2)[0];
    }
    private static HttpResponse<String> get(String base, String path, String cookie, int status) throws Exception {
        return request(HttpRequest.newBuilder(URI.create(base + path)).header("Cookie", cookie).GET().build(), status);
    }
    private static HttpResponse<String> send(String base, String path, String method, String cookie, String type, String origin, int status) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create(base + path)).header("Cookie", cookie).header("Content-Type", type);
        if (origin != null) builder.header("Origin", origin);
        return request(builder.method(method, HttpRequest.BodyPublishers.ofString("{}")).build(), status);
    }
    private static HttpResponse<String> request(HttpRequest request, int status) throws Exception {
        HttpResponse<String> response = CLIENT.send(request, HttpResponse.BodyHandlers.ofString());
        check(response.statusCode() == status, request.uri() + " expected " + status + ", got " + response.statusCode() + ": " + response.body());
        check(response.headers().firstValue("Cache-Control").orElse("").equals("no-store"), "Never cache authenticated responses");
        return response;
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
