package com.peentar.thriftquery;

public final class StrictJsonTest {
    public static void main(String[] args) {
        var value = StrictJson.object("{\"id\":9007199254740993,\"params\":{\"x\":[true,null,\"ok\"]}}");
        check(value.get("id").toString().equals("9007199254740993"), "integer ID preserved");
        check(StrictJson.parse("[]").isJsonArray(), "Parse transport shape before validating JSON-RPC message");
        for (String invalid : new String[]{"{\"a\":1,\"a\":2}", "{\"x\":{\"a\":1,\"a\":2}}", "[]", "{} {}", "{a:1}", "{\"x\":NaN}", "{\"x\":1,}", "{\"x\":1/*comment*/}", "{\"x\":\"\\u0000\"}"}) {
            try { StrictJson.object(invalid); throw new AssertionError("Accepted invalid JSON: " + invalid); }
            catch (IllegalArgumentException expected) { }
        }
        try { StrictJson.object("{\"x\":" + "[".repeat(80) + "1" + "]".repeat(80) + "}"); throw new AssertionError("depth cap"); }
        catch (IllegalArgumentException expected) { }
        System.out.println("Strict JSON tests passed");
    }
    static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
