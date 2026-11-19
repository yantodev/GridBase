package com.peentar.thriftquery;

/** Validated trusted identity; owner keys are persisted verbatim, never normalized. */
record Actor(String provider, String id, String login) {
    private static final String LOCAL_KEY = "local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

    Actor {
        if ("github".equals(provider)) {
            new GitHubAuth.User(id, login); // Retain exactly the GitHub transport's ID/login constraints.
        } else if ("local".equals(provider)) {
            if (id == null || !id.matches(LOCAL_KEY)) throw new IllegalArgumentException("Invalid local owner key");
            if (login == null || login.isBlank() || login.length() > 80 || login.codePoints().anyMatch(Character::isISOControl))
                throw new IllegalArgumentException("Local display name must contain 1-80 printable characters");
        } else throw new IllegalArgumentException("Invalid actor provider");
    }

    String ownerKey() { return id; }
    static Actor github(String id, String login) { return new Actor("github", id, login); }
    static Actor local(String uuid, String displayName) {
        if (uuid == null) throw new IllegalArgumentException("Invalid local UUID");
        return new Actor("local", "local:" + uuid, displayName);
    }
    static Actor fromOwnerKey(String ownerKey, String login) {
        validOwnerKey(ownerKey);
        return new Actor(ownerKey.startsWith("local:") ? "local" : "github", ownerKey, login);
    }
    static String validOwnerKey(String ownerKey) {
        if (ownerKey != null && ownerKey.matches(LOCAL_KEY)) return ownerKey;
        return GitHubAuth.validId(ownerKey);
    }
}
