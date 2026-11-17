package com.peentar.thriftquery;

import com.google.gson.*;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.StringReader;
import java.math.BigDecimal;

/** Strict bounded JSON; duplicate keys are rejected at every nesting level. */
final class StrictJson {
    private StrictJson() { }
    static JsonObject object(String text) {
        JsonElement value = parse(text);
        if (!value.isJsonObject()) throw new IllegalArgumentException("JSON object wajib digunakan.");
        return value.getAsJsonObject();
    }
    static JsonElement parse(String text) {
        try (JsonReader reader = new JsonReader(new StringReader(text))) {
            reader.setStrictness(Strictness.STRICT);
            JsonElement value = read(reader, 0);
            if (reader.peek() != JsonToken.END_DOCUMENT) throw new IllegalArgumentException();
            return value;
        } catch (Exception invalid) { throw new IllegalArgumentException("JSON tidak valid."); }
    }
    private static JsonElement read(JsonReader reader, int depth) throws Exception {
        if (depth > 32) throw new IllegalArgumentException();
        return switch (reader.peek()) {
            case BEGIN_OBJECT -> {
                JsonObject object = new JsonObject(); reader.beginObject();
                while (reader.hasNext()) {
                    String key = safe(reader.nextName());
                    if (object.has(key)) throw new IllegalArgumentException();
                    object.add(key, read(reader, depth + 1));
                }
                reader.endObject(); yield object;
            }
            case BEGIN_ARRAY -> {
                JsonArray array = new JsonArray(); reader.beginArray();
                while (reader.hasNext()) array.add(read(reader, depth + 1));
                reader.endArray(); yield array;
            }
            case STRING -> new JsonPrimitive(safe(reader.nextString()));
            case NUMBER -> {
                String number = reader.nextString();
                if (number.length() > 100) throw new IllegalArgumentException();
                BigDecimal decimal = new BigDecimal(number);
                if (Math.abs((long) decimal.scale()) > 10000) throw new IllegalArgumentException();
                yield new JsonPrimitive(decimal);
            }
            case BOOLEAN -> new JsonPrimitive(reader.nextBoolean());
            case NULL -> { reader.nextNull(); yield JsonNull.INSTANCE; }
            default -> throw new IllegalArgumentException();
        };
    }
    private static String safe(String value) {
        if (value.indexOf('\0') >= 0) throw new IllegalArgumentException();
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (++i >= value.length() || !Character.isLowSurrogate(value.charAt(i))) throw new IllegalArgumentException();
            } else if (Character.isLowSurrogate(c)) throw new IllegalArgumentException();
        }
        return value;
    }
    static String string(JsonObject object, String key, int maximum) {
        JsonElement element = object.get(key);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) throw new IllegalArgumentException("Field " + key + " wajib berupa teks.");
        String value = element.getAsString();
        if (value.isBlank() || value.length() > maximum || value.chars().anyMatch(c -> c < 32 || c == 127)) throw new IllegalArgumentException("Field " + key + " tidak valid.");
        return value;
    }
}
