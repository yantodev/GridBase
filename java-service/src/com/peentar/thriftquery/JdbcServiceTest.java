package com.peentar.thriftquery;

import java.util.List;
import java.util.Arrays;

public final class JdbcServiceTest {
    public static void main(String[] args) {
        if (!"SHOW NAMESPACES IN s3tables".equals(JdbcService.DATABASE_LIST_SQL)) {
            throw new AssertionError("Unexpected database list query: " + JdbcService.DATABASE_LIST_SQL);
        }

        JdbcService.QueryResult result = new JdbcService.QueryResult(
                List.of("id", "name"),
                Arrays.asList(Arrays.asList("1", "Ari"), Arrays.asList("2", null)),
                false,
                12
        );
        String expected = "{\"columns\":[\"id\",\"name\"],\"rows\":[{\"id\":\"1\",\"name\":\"Ari\"},{\"id\":\"2\",\"name\":null}],\"rowCount\":2,\"durationMs\":12,\"truncated\":false}";
        if (!expected.equals(result.toJson())) throw new AssertionError(result.toJson());
        System.out.println("Java JDBC result tests passed");
    }
}
