/*
 *   Copyright (c) 2026
 *   All rights reserved.
 */
package com.peentar.thriftquery;

import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Each request captures an immutable service so reconnects never redirect in-flight work. */
public final class ConnectionRegistry {
    private static final int MAX_CONNECTIONS = 20;
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final ServiceFactory factory;
    private String defaultId;

    public ConnectionRegistry(AppConfig config) {
        this(profile -> new JdbcService(config, profile));
    }

    ConnectionRegistry(ServiceFactory factory) {
        this.factory = factory;
    }

    public void test(ConnectionProfile profile) throws SQLException, ClassNotFoundException {
        factory.create(profile).testConnection();
    }

    public Entry connect(String requestedId, ConnectionProfile profile) throws SQLException, ClassNotFoundException {
        String id = requestedId == null || requestedId.isBlank() ? UUID.randomUUID().toString() : requestedId;
        if (!id.matches("[a-zA-Z0-9_-]{1,100}")) throw new IllegalArgumentException("ID koneksi tidak valid.");
        JdbcService service = factory.create(profile);
        service.testConnection(); // Failed reconnects preserve the previous working profile.
        synchronized (this) {
            if (!entries.containsKey(id) && entries.size() >= MAX_CONNECTIONS) {
                throw new IllegalArgumentException("Maksimal 20 koneksi. Putuskan koneksi lain terlebih dahulu.");
            }
            Entry entry = new Entry(id, service);
            entries.put(id, entry);
            if (defaultId == null) defaultId = id;
            return entry;
        }
    }

    public synchronized JdbcService require(String id) {
        boolean explicit = id != null && !id.isBlank();
        Entry entry = entries.get(explicit ? id : defaultId);
        if (entry == null) {
            if (explicit) throw new UnknownConnectionException();
            throw new IllegalStateException("Koneksi database belum dikonfigurasi.");
        }
        return entry.service();
    }

    public synchronized void disconnect(String id) {
        if (id == null || !entries.containsKey(id)) throw new UnknownConnectionException();
        entries.remove(id);
        if (id.equals(defaultId)) defaultId = null;
    }

    public synchronized Entry defaultEntry() { return entries.get(defaultId); }
    public synchronized String defaultId() { return defaultId; }
    public synchronized List<Entry> entries() { return List.copyOf(entries.values()); }

    public record Entry(String id, JdbcService service) {
        public String toJson() {
            String profile = service.profile().safeJson();
            return "{\"id\":" + JsonUtil.quote(id) + "," + profile.substring(1);
        }
    }

    public static final class UnknownConnectionException extends RuntimeException {
        UnknownConnectionException() { super("Koneksi tidak ditemukan. Hubungkan kembali koneksi yang dipilih."); }
    }

    @FunctionalInterface
    interface ServiceFactory { JdbcService create(ConnectionProfile profile); }
}
