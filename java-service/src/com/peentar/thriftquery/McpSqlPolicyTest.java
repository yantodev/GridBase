package com.peentar.thriftquery;

import java.util.List;

/** No database connection or external credentials are used. */
public final class McpSqlPolicyTest {
    private static int accepted;
    private static int rejected;

    public static void main(String[] args) {
        for (DatabaseType type : DatabaseType.values()) {
            allow(type, "SELECT 1");
            allow(type, "SELECT id, 'DELETE; -- not SQL' AS note FROM orders WHERE id > 2 LIMIT 20;");
            if (type == DatabaseType.POSTGRESQL) {
                allow(type, "SELECT \"odd;name\" FROM \"a--b\"");
                deny(type, "SELECT `id` FROM `a`");
            } else allow(type, "SELECT `odd;name` FROM `a--b`");
            if (type == DatabaseType.MYSQL) deny(type, "SELECT 1--not_a_mysql_comment\n");
            for (String sql : List.of(
                    "WITH totals AS (SELECT customer_id, SUM(amount) AS total FROM orders GROUP BY customer_id) SELECT t.customer_id, t.total FROM totals t LEFT JOIN customers c ON t.customer_id=c.id WHERE t.total > 10 ORDER BY t.total DESC LIMIT 5 OFFSET 2",
                    "WITH outer_cte AS (WITH inner_cte AS (SELECT 1 AS id) SELECT * FROM inner_cte) SELECT * FROM outer_cte",
                    "SELECT a.id, count(DISTINCT b.id) FROM a JOIN b USING(id) GROUP BY a.id HAVING count(*) > 1",
                    "SELECT id FROM a UNION ALL SELECT id FROM b INTERSECT SELECT id FROM c EXCEPT SELECT id FROM d",
                    "SELECT CASE WHEN id BETWEEN 1 AND 10 THEN lower(name) ELSE coalesce(name, 'n/a') END FROM a WHERE id IN (SELECT id FROM b WHERE flag IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM c WHERE c.id=a.id)",
                    "SELECT (SELECT max(id) FROM b) AS latest FROM a WHERE id IN (1,2,3) AND name LIKE 'a%'",
                    "SELECT DISTINCT a.* FROM a CROSS JOIN b ORDER BY a.id",
                    "SELECT abs(-2)+round(2.5), trim(' x '), substring('abc',1,2), concat('a','b')",
                    "/* harmless */ SELECT 'SELECT INTO; pg_sleep(9)' AS \"DROP TABLE\" -- harmless\n",
                    "SELECT 1 AS \"a;--b\"", "SELECT 'it''s fine'", "SELECT TRUE, NULL")) allow(type, sql);
            for (String sql : List.of(
                    "DELETE FROM orders", "INSERT INTO a VALUES (1)", "CREATE TABLE a(id int)", "DROP TABLE a", "UPDATE a SET id=1",
                    "SELECT 1; SELECT 2", "SELECT 1;;", "SELECT 1; DELETE FROM orders", "SELECT 1; !quit",
                    "WITH x AS (DELETE FROM a RETURNING *) SELECT * FROM x",
                    "WITH x AS (INSERT INTO a VALUES(1) RETURNING *) SELECT * FROM x",
                    "WITH x AS (UPDATE a SET id=2 RETURNING *) SELECT * FROM x",
                    "WITH x AS (SELECT 1) DELETE FROM a", "SELECT * FROM (WITH x AS (DELETE FROM a RETURNING *) SELECT * FROM x) q",
                    "SELECT (WITH x AS (DELETE FROM a RETURNING *) SELECT * FROM x)",
                    "SELECT * INTO b FROM a", "SELECT * INTO TEMP b FROM a", "SELECT id FROM a INTO OUTFILE '/tmp/out'",
                    "SELECT * FROM a FOR UPDATE", "SELECT * FROM a FOR SHARE", "SELECT * FROM a FOR UPDATE SKIP LOCKED",
                    "EXPLAIN ANALYZE DELETE FROM a", "SHOW TABLES", "DESCRIBE a", "SET x=1", "ADD JAR '/tmp/x.jar'",
                    "SELECT TRANSFORM(id) USING 'sh' AS output FROM a", "MAP a USING 'sh'", "REDUCE a USING 'sh'",
                    "SELECT pg_sleep(10)", "SELECT sleep(10)", "SELECT reflect('java.lang.Runtime', 'getRuntime')",
                    "SELECT java_method('java.lang.System','exit',0)", "SELECT load_file('/etc/passwd')",
                    "SELECT evil.abs(1)", "SELECT \"abs\"(1)", "SELECT `abs`(1)", "SELECT sum(evil()) FROM a",
                    "SELECT * FROM a WHERE EXISTS(SELECT evil())", "SELECT id FROM a ORDER BY evil()",
                    "WITH x AS (SELECT evil()) SELECT * FROM x", "SELECT id FROM a UNION SELECT evil()",
                    "SELECT 1 LIMIT evil()", "SELECT 1 OFFSET evil()", "SELECT * FROM evil()",
                    "SELECT a.id FROM a JOIN b ON evil()=1", "SELECT id FROM a GROUP BY evil()",
                    "SELECT count(*) FROM a HAVING evil()=1", "SELECT CASE WHEN 1=1 THEN evil() ELSE 0 END",
                    "SELECT trim(evil())", "SELECT sum((SELECT evil()))", "SELECT * FROM (SELECT evil()) q",
                    "SELECT CAST(1 AS dangerous_type)", "SELECT 1::dangerous_type", "SELECT ROW_NUMBER() OVER (ORDER BY id) FROM a",
                    "SELECT * FROM a TABLESAMPLE SYSTEM (10)", "SELECT * EXCEPT(id) FROM a", "VALUES (1)",
                    "SELECT 1 /*!50000 INTO OUTFILE '/tmp/pwn' */", "SELECT /*+ MAPJOIN(a) */ 1", "SELECT /*M! evil */ 1",
                    "SELECT 1 /* outer /* inner */ evil */", "SELECT 'unclosed", "SELECT (1", "SELECT 1 garbage trailing",
                    "SELECT @x := 1", "SELECT nextval('sequence')", "SELECT U&'x'", "SELECT E'x'", "SELECT $$x$$",
                    "SELECT 'back\\slash'")) deny(type, sql);
            deny(type, null);
            deny(type, " ");
            deny(type, "SELECT '" + "x".repeat(20_000) + "'");
            deny(type, "SELECT " + "(".repeat(70) + "1" + ")".repeat(70));
        }
        long parserThreads = Thread.getAllStackTraces().keySet().stream().filter(t -> t.getName().startsWith("mcp-sql-parser-")).count();
        if (parserThreads < 1 || parserThreads > 2) throw new AssertionError("SQL parser must use one bounded shared executor: " + parserThreads);
        boundedParserDeadline();
        System.out.println("Java MCP SQL policy tests passed (accepted=" + accepted + ", rejected=" + rejected + ")");
    }

    private static void boundedParserDeadline() {
        try {
            var field = McpSqlPolicy.class.getDeclaredField("PARSERS");
            field.setAccessible(true);
            var executor = (java.util.concurrent.ThreadPoolExecutor) field.get(null);
            var occupied = new java.util.concurrent.CountDownLatch(2);
            var release = new java.util.concurrent.CountDownLatch(1);
            Runnable blocker = () -> {
                occupied.countDown();
                try { release.await(); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            };
            try {
                executor.submit(blocker);
                executor.submit(blocker);
                if (!occupied.await(2, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("Parser fixture did not occupy both workers");
                long start = System.nanoTime();
                deny(DatabaseType.POSTGRESQL, "SELECT 1");
                if (System.nanoTime() - start > 2_000_000_000L) throw new AssertionError("Parser wait exceeded finite timeout");
                if (executor.getPoolSize() > 2 || executor.getQueue().size() > 2) throw new AssertionError("Unbounded parser capacity");
            } finally { release.countDown(); }
        } catch (ReflectiveOperationException | InterruptedException failure) { throw new AssertionError(failure); }
    }

    private static void allow(DatabaseType type, String sql) {
        try { McpSqlPolicy.validate(sql, type); accepted++; }
        catch (IllegalArgumentException failure) { throw new AssertionError("Rejected " + type + ": " + sql, failure); }
    }

    private static void deny(DatabaseType type, String sql) {
        try { McpSqlPolicy.validate(sql, type); }
        catch (IllegalArgumentException expected) { rejected++; return; }
        throw new AssertionError("Accepted " + type + ": " + sql);
    }
}
