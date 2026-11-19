package com.peentar.thriftquery;

import com.google.gson.*;
import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.util.*;

/** Trusted browser-session or native-capability management; never consumes bearer credentials. */
final class McpApi {
    private final McpTokenStore tokens;
    private final java.util.function.Supplier<String> endpoint;
    private final Actor localOwner;
    McpApi(McpTokenStore tokens, String appUrl) { this.tokens = tokens; endpoint = () -> appUrl + "/mcp"; localOwner = null; }
    McpApi(McpTokenStore tokens, LocalMcpControl control, Actor localOwner) {
        if (localOwner == null || !localOwner.provider().equals("local")) throw new IllegalArgumentException();
        this.tokens = tokens; this.endpoint = control::endpoint; this.localOwner = localOwner;
    }
    void handle(HttpExchange exchange, Actor actor, ConnectionRegistry connections) throws IOException {
        String path = exchange.getRequestURI().getPath(), method = exchange.getRequestMethod();
        try {
            if (actor == null) { send(exchange, 401, "Silakan login dengan GitHub."); return; }
            if (localOwner != null ? !localOwner.equals(actor) : !actor.ownerKey().equals(exchange.getRequestHeaders().getFirst("X-GridBase-Account"))) { send(exchange, 409, "Akun berubah. Muat ulang aplikasi."); return; }
            if (path.equals("/api/mcp/tokens")) {
                if (method.equals("GET")) {
                    JsonArray available = new JsonArray();
                    synchronized (connections) {
                        for (var entry : connections.entries()) {
                            var profile = connections.mcp(entry.id());
                            JsonObject item = new JsonObject(); item.addProperty("id", entry.id()); item.addProperty("name", profile.service().profile().name());
                            item.addProperty("type", profile.service().profile().type().id()); item.addProperty("mcpReadOnly", profile.readOnly()); available.add(item);
                        }
                    }
                    JsonArray list = new JsonArray(); for (var token : tokens.list(actor.ownerKey())) list.add(StrictJson.object(token.toJson()));
                    JsonObject response = new JsonObject(); response.add("tokens", list); response.add("connections", available); response.addProperty("endpoint", endpoint.get());
                    ThriftQueryServer.sendJson(exchange, 200, response.toString()); return;
                }
                if (method.equals("POST")) {
                    JsonObject body = StrictJson.object(ThriftQueryServer.readBody(exchange));
                    if (!Set.of("name", "scope", "expiresInDays", "connectionIds").containsAll(body.keySet())) throw new IllegalArgumentException();
                    String name = StrictJson.string(body, "name", 80), scope = StrictJson.string(body, "scope", 20);
                    if (!Set.of("read_only", "full_access").contains(scope)) throw new IllegalArgumentException();
                    JsonElement expiry = body.get("expiresInDays"), ids = body.get("connectionIds");
                    if (expiry == null || !expiry.isJsonPrimitive() || !expiry.getAsJsonPrimitive().isNumber() || !expiry.toString().matches("30|90|365") || ids == null || !ids.isJsonArray() || ids.getAsJsonArray().isEmpty() || ids.getAsJsonArray().size() > 20) throw new IllegalArgumentException();
                    List<McpTokenStore.Grant> grants = new ArrayList<>(); Set<String> seen = new HashSet<>();
                    synchronized (connections) {
                        for (JsonElement id : ids.getAsJsonArray()) {
                            if (!id.isJsonPrimitive() || !id.getAsJsonPrimitive().isString() || !seen.add(id.getAsString())) throw new IllegalArgumentException();
                            var profile = connections.mcp(id.getAsString());
                            if (scope.equals("read_only") && !profile.readOnly()) throw new IllegalArgumentException("read_only membutuhkan profil dengan kredensial khusus berizin baca.");
                            grants.add(new McpTokenStore.Grant(profile.id(), profile.generation(), profile.readOnly()));
                        }
                        var created = tokens.create(actor, name, scope, expiry.getAsInt(), grants);
                        JsonObject response = new JsonObject(); response.add("token", StrictJson.object(created.token().toJson())); response.addProperty("secret", created.secret());
                        ThriftQueryServer.sendJson(exchange, 201, response.toString()); return;
                    }
                }
                exchange.getResponseHeaders().set("Allow", "GET, POST"); send(exchange, 405, "Method tidak didukung."); return;
            }
            if (path.matches("/api/mcp/tokens/[0-9a-f-]{36}")) {
                if (!method.equals("DELETE")) { exchange.getResponseHeaders().set("Allow", "DELETE"); send(exchange, 405, "Method tidak didukung."); return; }
                String tokenId = path.substring("/api/mcp/tokens/".length());
                if (tokens.list(actor.ownerKey()).stream().noneMatch(token -> token.id().equals(tokenId))) { send(exchange, 404, "Token tidak ditemukan."); return; }
                tokens.revoke(actor.ownerKey(), tokenId);
                ThriftQueryServer.sendJson(exchange, 200, "{\"ok\":true}"); return;
            }
            send(exchange, 404, "Endpoint tidak ditemukan.");
        } catch (ConnectionRegistry.UnknownConnectionException missing) { send(exchange, 404, "Koneksi atau token tidak ditemukan."); }
        catch (IllegalArgumentException invalid) { send(exchange, 400, "Pengaturan token tidak valid. Pilih koneksi tersimpan yang sesuai scope dan masa berlaku 30, 90, atau 365 hari."); }
    }
    private static void send(HttpExchange exchange, int status, String message) throws IOException { ThriftQueryServer.sendJson(exchange, status, "{\"error\":" + JsonUtil.quote(message) + "}"); }
}
