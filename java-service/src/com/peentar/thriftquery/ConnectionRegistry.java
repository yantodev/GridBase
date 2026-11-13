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
    private final ConnectionStore store;
    private String defaultId;

    public ConnectionRegistry(AppConfig config, String ownerId) {
        this(profile -> new JdbcService(config, profile), new ConnectionStore(config.dataDir, ownerId));
    }

    ConnectionRegistry(ServiceFactory factory) {
        this(factory, null);
    }

    ConnectionRegistry(ServiceFactory factory, ConnectionStore store) {
        this.factory = factory;
        this.store = store;
        if (store != null) store.load().forEach((id, settings) ->
                entries.put(id, new Entry(id, settings, factory.create(settings.profile()), false)));
    }

    public void test(ConnectionProfile profile) throws SQLException, ClassNotFoundException {
        factory.create(profile).testConnection();
    }

    public Entry connect(String requestedId, ConnectionProfile profile) throws SQLException, ClassNotFoundException {
        return connect(requestedId, ConnectionSettings.of(profile));
    }

    public Entry connect(String requestedId, ConnectionSettings settings) throws SQLException, ClassNotFoundException {
        String id = connectionId(requestedId);
        checkWritable(id);
        JdbcService service = factory.create(settings.profile());
        service.testConnection(); // Failed reconnects preserve the previous working profile.
        synchronized (this) {
            checkCapacity(id);
            if (store != null) store.save(id, settings);
            Entry entry = new Entry(id, settings, service, true);
            entries.put(id, entry);
            if (defaultId == null) defaultId = id;
            return entry;
        }
    }

    public synchronized JdbcService require(String id) {
        boolean explicit = id != null && !id.isBlank();
        Entry entry = entries.get(explicit ? id : defaultId);
        if (entry == null || !entry.connected()) {
            if (explicit) throw new UnknownConnectionException();
            throw new IllegalStateException("Koneksi database belum dikonfigurasi.");
        }
        return entry.service();
    }

    public synchronized void disconnect(String id) {
        Entry entry = entries.get(id);
        if (entry == null || !entry.connected()) throw new UnknownConnectionException();
        entries.put(id, new Entry(id, entry.settings(), entry.service(), false));
        if (id.equals(defaultId)) defaultId = null;
    }

    public synchronized Entry save(String requestedId, ConnectionSettings settings) {
        String id = connectionId(requestedId);
        checkWritable(id);
        checkCapacity(id);
        JdbcService service = factory.create(settings.profile());
        if (store != null) store.save(id, settings);
        Entry entry = new Entry(id, settings, service, false);
        entries.put(id, entry);
        if (id.equals(defaultId)) defaultId = null;
        return entry;
    }

    public synchronized ConnectionSettings details(String id) {
        Entry entry = entries.get(id);
        if (entry == null) throw new UnknownConnectionException();
        return entry.settings();
    }

    public synchronized void delete(String id) {
        if (!entries.containsKey(id)) throw new UnknownConnectionException();
        if (store != null) store.delete(id);
        entries.remove(id);
        if (id.equals(defaultId)) defaultId = null;
    }

    void checkWritable(String id) {
        if (id != null && !id.isBlank() && store != null && !store.canWrite(id)) throw new UnknownConnectionException();
    }

    private static String connectionId(String requestedId) {
        String id = requestedId == null || requestedId.isBlank() ? UUID.randomUUID().toString() : requestedId;
        if (!id.matches("[a-zA-Z0-9_-]{1,100}")) throw new IllegalArgumentException("ID koneksi tidak valid.");
        return id;
    }

    private void checkCapacity(String id) {
        if (!entries.containsKey(id) && entries.size() >= MAX_CONNECTIONS) {
            throw new IllegalArgumentException("Maksimal 20 koneksi. Hapus koneksi tersimpan terlebih dahulu.");
        }
    }

    public synchronized Entry defaultEntry() { return entries.get(defaultId); }
    public synchronized String defaultId() { return defaultId; }
    public synchronized List<Entry> entries() { return List.copyOf(entries.values()); }

    public record Entry(String id, ConnectionSettings settings, JdbcService service, boolean connected) {
        public String toJson() {
            String profile = service.profile().safeJson();
            return "{\"id\":" + JsonUtil.quote(id) + ",\"connected\":" + connected + "," + profile.substring(1);
        }
    }

    public static final class UnknownConnectionException extends RuntimeException {
        UnknownConnectionException() { super("Koneksi tidak ditemukan. Hubungkan kembali koneksi yang dipilih."); }
    }

    @FunctionalInterface
    interface ServiceFactory { JdbcService create(ConnectionProfile profile); }
}
