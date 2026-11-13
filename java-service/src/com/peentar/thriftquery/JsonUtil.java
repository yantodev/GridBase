package com.peentar.thriftquery;

import java.util.List;

public final class JsonUtil {
    private JsonUtil() {
    }

    public static String stringField(String json, String field) {
        int cursor = fieldValueStart(json, field);
        if (cursor < 0) throw new IllegalArgumentException("Missing JSON field");
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
        if (fieldValueStart(json, field) < 0) return fallback;
        return stringField(json, field);
    }

    public static boolean booleanFieldOrDefault(String json, String field, boolean fallback) {
        int cursor = fieldValueStart(json, field);
        if (cursor < 0) return fallback;
        if (booleanToken(json, cursor, "true")) return true;
        if (booleanToken(json, cursor, "false")) return false;
        throw new IllegalArgumentException("JSON field must be boolean");
    }

    // Skip complete string tokens, and only match a property followed by a colon.
    // Looking for quoted text alone also matches values such as name="password".
    private static int fieldValueStart(String json, String field) {
        if (json == null) return -1;
        for (int index = 0; index < json.length(); index++) {
            if (json.charAt(index) != '"') continue;
            int start = ++index;
            for (; index < json.length(); index++) {
                char current = json.charAt(index);
                if (current == '\\') { index++; continue; }
                if (current == '"') break;
            }
            if (index >= json.length()) throw new IllegalArgumentException("Unterminated JSON string");
            if (!json.substring(start, index).equals(field)) continue;
            int next = index + 1;
            while (next < json.length() && Character.isWhitespace(json.charAt(next))) next++;
            if (next >= json.length() || json.charAt(next) != ':') continue;
            next++;
            while (next < json.length() && Character.isWhitespace(json.charAt(next))) next++;
            return next;
        }
        return -1;
    }

    private static boolean booleanToken(String json, int cursor, String token) {
        if (!json.startsWith(token, cursor)) return false;
        int end = cursor + token.length();
        return end == json.length() || Character.isWhitespace(json.charAt(end)) || ",}]".indexOf(json.charAt(end)) >= 0;
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
