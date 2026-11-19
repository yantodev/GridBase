package com.peentar.thriftquery;

import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;

/** Immutable in-memory AES-256 key. No local raw-key file is read or written. */
final class CredentialKey {
    private final byte[] bytes;
    CredentialKey(byte[] bytes) {
        if (bytes == null || bytes.length != 32) throw new IllegalArgumentException("A 32-byte credential key is required.");
        this.bytes = bytes.clone();
    }
    SecretKey secretKey() { return new SecretKeySpec(bytes, "AES"); }
    @Override public String toString() { return "CredentialKey[REDACTED]"; }
}
