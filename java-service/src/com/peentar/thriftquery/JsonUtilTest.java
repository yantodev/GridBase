package com.peentar.thriftquery;

import java.util.List;

public final class JsonUtilTest {
    public static void main(String[] args) {
        String sql = JsonUtil.stringField("{\"sql\":\"SELECT \\\"name\\\"\\nFROM users\"}", "sql");
        check("SELECT \"name\"\nFROM users".equals(sql), "JSON string escapes should decode");
        check("\"line\\nquote \\\"ok\\\"\"".equals(JsonUtil.quote("line\nquote \"ok\"")), "JSON strings should encode");
        check("[\"default\",\"analytics\"]".equals(JsonUtil.stringArray(List.of("default", "analytics"))), "JSON arrays should encode");
        System.out.println("Java JSON tests passed");
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
