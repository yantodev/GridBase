package com.peentar.thriftquery;

public final class ConnectionProfileTest {
    public static void main(String[] args) {
        ConnectionProfile postgres = ConnectionProfile.fromJson("{\"type\":\"postgresql\",\"name\":\"Local PG\",\"host\":\"127.0.0.1\",\"port\":\"5432\",\"database\":\"app db\",\"username\":\"postgres\",\"password\":\"secret\",\"ssl\":true}");
        check(postgres.jdbcUrl().equals("jdbc:postgresql://127.0.0.1:5432/app%20db?sslmode=require"), postgres.jdbcUrl());
        ConnectionProfile mysql = ConnectionProfile.fromJson("{\"type\":\"mysql\",\"host\":\"db.local\",\"database\":\"app\",\"username\":\"root\",\"password\":\"secret\"}");
        check(mysql.jdbcUrl().startsWith("jdbc:mysql://db.local:3306/app?useSSL=false"), mysql.jdbcUrl());
        check(!postgres.safeJson().contains("secret"), "safe connection JSON must not contain password");
        expectInvalid(() -> ConnectionProfile.fromJson("{\"type\":\"postgresql\",\"host\":\"db.local/path\",\"database\":\"app\",\"username\":\"u\",\"password\":\"p\"}"));
        expectInvalid(() -> ConnectionProfile.fromJson("{\"type\":\"oracle\",\"username\":\"u\",\"password\":\"p\",\"jdbcUrl\":\"jdbc:oracle:thin:@db\"}"));
        System.out.println("Connection profile tests passed");
    }

    private static void expectInvalid(Runnable action) {
        try {
            action.run();
            throw new AssertionError("Expected invalid connection profile");
        } catch (IllegalArgumentException expected) {
            // Expected validation failure.
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
