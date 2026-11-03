package com.peentar.thriftquery;

public final class SqlPolicyTest {
    public static void main(String[] args) {
        SqlPolicy.Result select = SqlPolicy.validate("  SELECT 1;  ", 20_000);
        check(select.ok(), "SELECT should be accepted");
        check("SELECT 1".equals(select.sql()), "trailing semicolon should be removed");

        SqlPolicy.Result comment = SqlPolicy.validate("-- note\nSHOW DATABASES", 20_000);
        check(comment.ok(), "commented SHOW should be accepted");

        SqlPolicy.Result mutation = SqlPolicy.validate("DROP TABLE users", 20_000);
        check(!mutation.ok(), "DROP should be rejected");

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
