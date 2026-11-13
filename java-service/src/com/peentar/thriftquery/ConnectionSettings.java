package com.peentar.thriftquery;

/** Full form settings; never include these in list or health responses. */
public record ConnectionSettings(ConnectionProfile profile, String host, String port, String database, boolean ssl) {
    public static ConnectionSettings fromJson(String json) {
        ConnectionProfile profile = ConnectionProfile.fromJson(json);
        return new ConnectionSettings(profile,
                JsonUtil.stringFieldOrDefault(json, "host", "").trim(),
                JsonUtil.stringFieldOrDefault(json, "port", String.valueOf(profile.type().defaultPort())).trim(),
                JsonUtil.stringFieldOrDefault(json, "database", "").trim(),
                JsonUtil.booleanFieldOrDefault(json, "ssl", false));
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
                + ",\"jdbcUrl\":" + JsonUtil.quote(profile.jdbcUrl())
                + ",\"username\":" + JsonUtil.quote(profile.username())
                + ",\"password\":" + JsonUtil.quote(profile.password()) + "}";
    }

    @Override public String toString() { return "ConnectionSettings[redacted]"; }
}
