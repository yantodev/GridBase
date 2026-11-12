package com.peentar.thriftquery;

import java.util.List;

public final class JsonUtil {
    private JsonUtil() {
    }

    public static String stringField(String json, String field) {
        String key = "\"" + field + "\"";
        int keyIndex = json.indexOf(key);
        if (keyIndex < 0) throw new IllegalArgumentException("Missing JSON field");
        int colon = json.indexOf(':', keyIndex + key.length());
        if (colon < 0) throw new IllegalArgumentException("Invalid JSON field");
        int cursor = colon + 1;
        while (cursor < json.length() && Character.isWhitespace(json.charAt(cursor))) cursor++;
        if (cursor >= json.length() || json.charAt(cursor) != '"') throw new IllegalArgumentException("JSON field must be a string");

        StringBuilder result = new StringBuilder();
        for (int index = cursor + 1; index < json.length(); index++) {
            char current = json.charAt(index);
            if (current == '"') return result.toString();
            if (current != '\\') {
                result.append(current);
                continue;
            }
            if (++index >= json.length()) throw new IllegalArgumentException("Invalid JSON escape");
            char escaped = json.charAt(index);
            switch (escaped) {
                case '"' -> result.append('"');
                case '\\' -> result.append('\\');
                case '/' -> result.append('/');
                case 'b' -> result.append('\b');
                case 'f' -> result.append('\f');
                case 'n' -> result.append('\n');
                case 'r' -> result.append('\r');
                case 't' -> result.append('\t');
                case 'u' -> {
                    if (index + 4 >= json.length()) throw new IllegalArgumentException("Invalid unicode escape");
                    String hex = json.substring(index + 1, index + 5);
                    result.append((char) Integer.parseInt(hex, 16));
                    index += 4;
                }
                default -> throw new IllegalArgumentException("Invalid JSON escape");
            }
        }
        throw new IllegalArgumentException("Unterminated JSON string");
    }

    public static String stringFieldOrDefault(String json, String field, String fallback) {
        String key = "\"" + field + "\"";
        if (json == null || json.indexOf(key) < 0) return fallback;
        return stringField(json, field);
    }

    public static boolean booleanFieldOrDefault(String json, String field, boolean fallback) {
        String key = "\"" + field + "\"";
        int keyIndex = json == null ? -1 : json.indexOf(key);
        if (keyIndex < 0) return fallback;
        int colon = json.indexOf(':', keyIndex + key.length());
        if (colon < 0) throw new IllegalArgumentException("Invalid JSON field");
        String value = json.substring(colon + 1).trim().toLowerCase();
        if (value.startsWith("true")) return true;
        if (value.startsWith("false")) return false;
        throw new IllegalArgumentException("JSON field must be boolean");
    }

    public static String quote(String value) {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder("\"");
        for (char current : value.toCharArray()) {
            switch (current) {
                case '"' -> result.append("\\\"");
                case '\\' -> result.append("\\\\");
                case '\b' -> result.append("\\b");
                case '\f' -> result.append("\\f");
                case '\n' -> result.append("\\n");
                case '\r' -> result.append("\\r");
                case '\t' -> result.append("\\t");
                default -> {
                    if (current < 0x20) result.append(String.format("\\u%04x", (int) current));
                    else result.append(current);
                }
            }
        }
        return result.append('"').toString();
    }

    public static String stringArray(List<String> values) {
        StringBuilder result = new StringBuilder("[");
        for (int index = 0; index < values.size(); index++) {
            if (index > 0) result.append(',');
            result.append(quote(values.get(index)));
        }
        return result.append(']').toString();
    }
}
