package com.peentar.thriftquery;

import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.util.Set;

/** Trusted embedding boundary, not an authentication mode or a client-selected owner. */
interface RequestAuth {
    Actor actor(HttpExchange exchange);
    /** True if authentication/public-route handling completed the request. */
    boolean handle(HttpExchange exchange, Set<String> auditAdmins) throws IOException;
}
