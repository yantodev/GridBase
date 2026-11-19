package com.peentar.thriftquery;

import java.util.HashMap;
import java.util.Map;

/** Runtime connection/default state belongs to one trusted actor owner key. */
final class ConnectionWorkspaces {
    private final AppConfig config;
    private final ConnectionRegistry.ServiceFactory factory;
    private final LocalWorkspace localWorkspace;
    private final Map<String, ConnectionRegistry> accounts = new HashMap<>();

    ConnectionWorkspaces(AppConfig config) { this(config, profile -> new JdbcService(config, profile)); }
    ConnectionWorkspaces(AppConfig config, ConnectionRegistry.ServiceFactory factory) {
        this(config, factory, null);
    }
    ConnectionWorkspaces(AppConfig config, LocalWorkspace workspace) {
        this(config, profile -> new JdbcService(config, profile), java.util.Objects.requireNonNull(workspace));
    }
    ConnectionWorkspaces(AppConfig config, LocalWorkspace workspace, ConnectionRegistry.ServiceFactory factory) {
        this(config, factory, java.util.Objects.requireNonNull(workspace));
    }
    boolean localOwner(LocalAuth auth) { return localWorkspace != null && auth.owns(localWorkspace.actor()); }
    LocalWorkspace localWorkspace() {
        if (localWorkspace == null) throw new IllegalStateException("Not a local workspace.");
        return localWorkspace;
    }
    private ConnectionWorkspaces(AppConfig config, ConnectionRegistry.ServiceFactory factory, LocalWorkspace workspace) {
        if (config.localMode != (workspace != null) || workspace != null && !config.dataDir.equals(workspace.dataDir()))
            throw new IllegalArgumentException("Local configuration requires its engine-owned workspace and injected key.");
        this.config = config;
        this.factory = factory;
        this.localWorkspace = workspace;
        if (!config.legacyConnectionOwnerId.isEmpty()) ConnectionStore.migrateLegacy(config.dataDir, config.legacyConnectionOwnerId);
    }
    synchronized ConnectionRegistry forOwner(String ownerId) {
        Actor.validOwnerKey(ownerId);
        if (localWorkspace != null && !localWorkspace.actor().ownerKey().equals(ownerId)) throw new IllegalArgumentException("Local workspace actor mismatch.");
        return accounts.computeIfAbsent(ownerId, id -> new ConnectionRegistry(factory, localWorkspace == null
                ? new ConnectionStore(config.dataDir, id)
                : new ConnectionStore(config.dataDir, localWorkspace.actor(), localWorkspace.key())));
    }
    ConnectionRegistry forOwner(Actor actor) { return forOwner(java.util.Objects.requireNonNull(actor).ownerKey()); }
}
