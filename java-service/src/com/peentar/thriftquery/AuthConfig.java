package com.peentar.thriftquery;

import java.net.URI;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

record AuthConfig(String appUrl, String clientId, String clientSecret, Set<String> allowedUsers) {
    AuthConfig {
        URI uri = URI.create(appUrl);
        boolean local = Set.of("localhost", "127.0.0.1", "[::1]").contains(uri.getHost() == null ? "" : uri.getHost());
        if (uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                || !(uri.getPath().isEmpty() || uri.getPath().equals("/"))
                || !("https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) && local))) {
            throw new IllegalArgumentException("APP_URL harus berupa origin HTTPS, atau HTTP localhost untuk pengembangan.");
        }
        int port = uri.getPort();
        boolean defaultPort = port == -1 || (port == 443 && uri.getScheme().equals("https")) || (port == 80 && uri.getScheme().equals("http"));
        appUrl = uri.getScheme() + "://" + uri.getHost().toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
        clientId = clientId.trim();
        clientSecret = clientSecret.trim();
        allowedUsers = Set.copyOf(allowedUsers);
    }

    static Set<String> users(String value) {
        return Arrays.stream(value.split(",")).map(String::trim).filter(user -> !user.isEmpty())
                .map(user -> user.toLowerCase(Locale.ROOT)).collect(Collectors.toUnmodifiableSet());
    }

    boolean configured() { return !clientId.isEmpty() && !clientSecret.isEmpty(); }
    boolean secure() { return appUrl.startsWith("https:"); }
    String callbackUrl() { return appUrl + "/auth/github/callback"; }
}
