package com.peentar.thriftquery;

import java.sql.SQLTimeoutException;
import java.util.concurrent.TimeUnit;

/** Immutable authorization ceiling and independent resource budget for one MCP call. */
public record McpExecutionPolicy(String generation, boolean readOnly, int rowLimit, int metadataLimit, long deadlineNanos) {
    public static final int MAX_ROWS = 500;
    public static final int MAX_METADATA = 1000;
    public static final int MAX_RESPONSE_BYTES = 1_048_576;

    public McpExecutionPolicy {
        if (generation == null || generation.isBlank() || generation.length() > 128
                || generation.chars().anyMatch(c -> c < 32 || c == 127))
            throw new IllegalArgumentException("MCP profile generation is required");
        if (rowLimit < 1 || rowLimit > MAX_ROWS || metadataLimit < 1 || metadataLimit > MAX_METADATA)
            throw new IllegalArgumentException("MCP row/metadata limits exceed hard ceilings");
    }

    public long remainingNanos() throws SQLTimeoutException {
        long remaining = deadlineNanos - System.nanoTime();
        if (Thread.currentThread().isInterrupted() || remaining <= 0)
            throw new SQLTimeoutException("MCP execution deadline exceeded");
        return remaining;
    }

    public int timeoutSeconds(int configuredSeconds) throws SQLTimeoutException {
        long remaining = remainingNanos();
        long seconds = 1 + (remaining - 1) / TimeUnit.SECONDS.toNanos(1);
        return (int) Math.max(1, Math.min(seconds, Math.max(1, configuredSeconds)));
    }
}
