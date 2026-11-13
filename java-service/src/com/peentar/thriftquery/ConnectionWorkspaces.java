package com.peentar.thriftquery;

import java.util.HashMap;
import java.util.Map;

/** Runtime connection/default state belongs to one verified GitHub ID. */
final class ConnectionWorkspaces {
    private final AppConfig config;
    private final ConnectionRegistry.ServiceFactory factory;
    private final Map<String, ConnectionRegistry> accounts = new HashMap<>();

    ConnectionWorkspaces(AppConfig config) { this(config, profile -> new JdbcService(config, profile)); }
    ConnectionWorkspaces(AppConfig config, ConnectionRegistry.ServiceFactory factory) {
        this.config = config;
        this.factory = factory;
        if (!config.legacyConnectionOwnerId.isEmpty()) ConnectionStore.migrateLegacy(config.dataDir, config.legacyConnectionOwnerId);
    }
    synchronized ConnectionRegistry forOwner(String ownerId) {
        GitHubAuth.validId(ownerId);
        return accounts.computeIfAbsent(ownerId, id -> new ConnectionRegistry(factory, new ConnectionStore(config.dataDir, id)));
    }
}
