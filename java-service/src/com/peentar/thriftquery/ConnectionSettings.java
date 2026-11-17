package com.peentar.thriftquery;

import java.util.UUID;

/** Full form settings; never include these in list or health responses. */
public record ConnectionSettings(ConnectionProfile profile, String host, String port, String database, boolean ssl,
                                 boolean mcpReadOnly, String generation) {
    public ConnectionSettings {
        if (generation != null && !validGeneration(generation)) throw new IllegalArgumentException("Invalid profile generation");
    }

    public ConnectionSettings(ConnectionProfile profile, String host, String port, String database, boolean ssl) {
        this(profile, host, port, database, ssl, false, null);
    }

    public ConnectionSettings(ConnectionProfile profile, String host, String port, String database, boolean ssl, boolean mcpReadOnly) {
        this(profile, host, port, database, ssl, mcpReadOnly, null);
    }

    public static ConnectionSettings fromJson(String json) {
        ConnectionProfile profile = ConnectionProfile.fromJson(json);
        return new ConnectionSettings(profile,
                JsonUtil.stringFieldOrDefault(json, "host", "").trim(),
                JsonUtil.stringFieldOrDefault(json, "port", String.valueOf(profile.type().defaultPort())).trim(),
                JsonUtil.stringFieldOrDefault(json, "database", "").trim(),
                JsonUtil.booleanFieldOrDefault(json, "ssl", false),
                JsonUtil.booleanFieldOrDefault(json, "mcpReadOnly", false));
    }

    /** Trusted encrypted-storage loader only. Browser input must always use fromJson. */
    static ConnectionSettings fromStoredJson(String json) {
        ConnectionSettings settings = fromJson(json);
        return settings.withGeneration(JsonUtil.stringFieldOrDefault(json, "generation", null));
    }

    static boolean validGeneration(String value) {
        if (value == null || !value.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) return false;
        return UUID.fromString(value).toString().equals(value);
    }

    ConnectionSettings withGeneration(String value) {
        return new ConnectionSettings(profile, host, port, database, ssl, mcpReadOnly, value);
    }

    boolean sameSettings(ConnectionSettings other) {
        return other != null && profile.equals(other.profile) && host.equals(other.host) && port.equals(other.port)
                && database.equals(other.database) && ssl == other.ssl && mcpReadOnly == other.mcpReadOnly;
    }

    static ConnectionSettings of(ConnectionProfile profile) {
        return new ConnectionSettings(profile, "", String.valueOf(profile.type().defaultPort()), "", false);
    }

    public String toJson() {
        return "{\"type\":" + JsonUtil.quote(profile.type().id())
                + ",\"name\":" + JsonUtil.quote(profile.name())
                + ",\"host\":" + JsonUtil.quote(host)
                + ",\"port\":" + JsonUtil.quote(port)
                + ",\"database\":" + JsonUtil.quote(database)
                + ",\"ssl\":" + ssl
                + ",\"mcpReadOnly\":" + mcpReadOnly
                + (generation == null ? "" : ",\"generation\":" + JsonUtil.quote(generation))
                + ",\"jdbcUrl\":" + JsonUtil.quote(profile.jdbcUrl())
                + ",\"username\":" + JsonUtil.quote(profile.username())
                + ",\"password\":" + JsonUtil.quote(profile.password()) + "}";
    }

    @Override public String toString() { return "ConnectionSettings[redacted]"; }
}
