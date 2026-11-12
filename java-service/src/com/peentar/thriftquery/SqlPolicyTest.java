package com.peentar.thriftquery;

public final class SqlPolicyTest {
    public static void main(String[] args) {
        SqlPolicy.Result select = SqlPolicy.validate("  SELECT 1;  ", 20_000);
        check(select.ok(), "SELECT should be accepted");
        check("SELECT 1".equals(select.sql()), "trailing semicolon should be removed");

        SqlPolicy.Result comment = SqlPolicy.validate("-- note\nSHOW DATABASES", 20_000);
        check(comment.ok(), "commented SHOW should be accepted");

        for (String sql : new String[]{
                "CREATE TABLE users (id INT)", "INSERT INTO users VALUES (1)",
                "UPDATE users SET id = 2 WHERE id = 1", "DELETE FROM users WHERE id = 2",
                "DROP TABLE users", "ALTER TABLE users ADD COLUMN name STRING", "TRUNCATE TABLE users",
                "MERGE INTO users USING changes ON users.id = changes.id WHEN MATCHED THEN DELETE",
                "WITH values_to_insert AS (SELECT 1 AS id) INSERT INTO users SELECT id FROM values_to_insert"
        }) {
            check(SqlPolicy.validate(sql, 20_000).ok(), "SQL statement should be accepted: " + sql);
        }
        String quoted = "UPDATE users SET note = 'https://example.test/a--b/*value*/;delete' WHERE id = 1";
        check(quoted.equals(SqlPolicy.validate("-- update note\n" + quoted + "; -- trailing note", 20_000).sql()),
                "literal values should be preserved while actual comments are removed");
        check(SqlPolicy.validate("SELECT 'can''t;delete', `update` FROM users", 20_000).ok(), "quoted tokens should be accepted");
        check(SqlPolicy.validate("UPDATE users SET note = '" + "x".repeat(8000) + "' WHERE id = 1", 20_000).ok(),
                "long quoted values must not overflow the parser stack");
        check(!SqlPolicy.validate("SELECT 1; DELETE FROM users", 20_000).ok(), "multiple statements should be rejected");
        check(!SqlPolicy.validate("SELECT 1;\n!sh touch /tmp/unwanted", 20_000).ok(), "client commands should be rejected");
        check(!SqlPolicy.validate("!quit", 20_000).ok(), "client commands should be rejected");
        check(!SqlPolicy.validate("-- comment only", 20_000).ok(), "comment-only SQL should be rejected");
        check(!SqlPolicy.validate("SELECT '\0'", 20_000).ok(), "NUL characters should be rejected");

        SqlPolicy.Result empty = SqlPolicy.validate("  ", 20_000);
        check(!empty.ok(), "empty SQL should be rejected");

        SqlPolicy.Result oversized = SqlPolicy.validate("SELECT 1", 4);
        check(!oversized.ok(), "oversized SQL should be rejected");

        System.out.println("Java SQL policy tests passed");
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
