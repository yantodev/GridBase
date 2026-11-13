package com.peentar.thriftquery;

import java.util.List;

public final class JsonUtilTest {
    public static void main(String[] args) {
        String sql = JsonUtil.stringField("{\"sql\":\"SELECT \\\"name\\\"\\nFROM users\"}", "sql");
        check("SELECT \"name\"\nFROM users".equals(sql), "JSON string escapes should decode");
        check("\"line\\nquote \\\"ok\\\"\"".equals(JsonUtil.quote("line\nquote \"ok\"")), "JSON strings should encode");
        check("[\"default\",\"analytics\"]".equals(JsonUtil.stringArray(List.of("default", "analytics"))), "JSON arrays should encode");
        check("actual-secret".equals(JsonUtil.stringField("{\"name\":\"password\",\"host\":\"fixture\",\"password\":\"actual-secret\"}", "password")), "A string value matching a key must not replace the credential");
        check(JsonUtil.booleanFieldOrDefault("{\"name\":\"ssl\",\"host\":\"fixture\",\"ssl\":true}", "ssl", false), "Boolean lookup ignores string values");
        check(JsonUtil.positiveIntegerField("{\"id\":49233072,\"login\":\"fixture\"}", "id").equals("49233072"), "GitHub numeric ID remains exact");
        for (String invalid : List.of("null", "0", "-1", "1.2", "1e3", "\"1001\"", "01", "true")) {
            try { JsonUtil.positiveIntegerField("{\"id\":" + invalid + "}", "id"); throw new AssertionError("Invalid GitHub ID accepted: " + invalid); }
            catch (IllegalArgumentException expected) { }
        }
        System.out.println("Java JSON tests passed");
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
