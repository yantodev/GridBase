package com.peentar.thriftquery;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

public final class JdbcMetadataTest {
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("thrift-metadata-test");
        try {
            AppConfig config = AppConfig.load(root, Map.of("DEFAULT_QUERY_LIMIT", "10"));
            List<String> labels = new ArrayList<>();
            List<List<String>> rows = new ArrayList<>();
            String[] executed = {""};
            Statement statement = proxy(Statement.class, (o,m,a) -> switch (m.getName()) {
                case "execute" -> { executed[0]=(String)a[0]; yield true; }
                case "getResultSet" -> resultSet(labels, rows);
                case "setQueryTimeout", "close" -> null;
                default -> throw new UnsupportedOperationException(m.getName());
            });
            Connection connection = proxy(Connection.class, (o,m,a) -> switch (m.getName()) {
                case "createStatement" -> statement;
                case "setReadOnly", "close" -> null;
                default -> throw new UnsupportedOperationException(m.getName());
            });
            JdbcService service = new JdbcService(config, new ConnectionProfile(DatabaseType.HIVE, "Fixture", "jdbc:hive2://fixture.example/default", "fixture", "fixture"), () -> connection);
            labels.add("namespace");
            for(int i=0;i<25;i++) rows.add(List.of("schema_"+i));
            if(service.databases().size()!=25) throw new AssertionError("Metadata must bypass ten-row query cap");
            if(service.query("SELECT namespace").rows().size()!=10) throw new AssertionError("Query cap must remain ten");
            labels.clear(); labels.addAll(List.of("namespace","tableName","isTemporary"));rows.clear();
            for(int i=0;i<25;i++) rows.add(List.of("a`b","table_"+i,"false"));
            if(service.tables("a`b").size()!=25) throw new AssertionError("All tables must be returned");
            if(!executed[0].equals("SHOW TABLES IN `s3tables`.`a``b`")) throw new AssertionError(executed[0]);
            labels.clear();labels.addAll(List.of("col_name","data_type","comment"));rows.clear();
            rows.add(Arrays.asList("id","bigint",null)); rows.add(List.of("# Partition Information","",""));
            rows.add(List.of("","",""));rows.add(List.of("id","bigint","")); rows.add(List.of("note","string","comment"));
            rows.add(List.of("# col_name","data_type","comment"));rows.add(List.of("#id","bigint",""));
            List<JdbcService.Column> columns = service.columns("a`b","t; DROP TABLE x");
            if(columns.size()!=3 || !columns.get(0).type().equals("bigint") || !columns.get(1).comment().equals("comment")) throw new AssertionError(columns);
            if(!columns.get(2).name().equals("#id"))throw new AssertionError("Valid hash-prefixed column must be retained");
            if(!executed[0].equals("DESCRIBE `s3tables`.`a``b`.`t; DROP TABLE x`")) throw new AssertionError(executed[0]);
            for(String bad:Arrays.asList(null,""," ","x".repeat(257),"a\n!quit")) {
                try {service.tables(bad);throw new AssertionError("Expected invalid identifier");} catch(IllegalArgumentException expected) { }
            }
            labels.clear();labels.add("namespace");rows.clear();
            for(int i=0;i<10005;i++)rows.add(List.of("schema_"+i));
            if(service.databases().size()!=10000)throw new AssertionError("Independent metadata ceiling required");
        } finally {Files.delete(root);}
        System.out.println("Java JDBC metadata tests passed");
    }
    private static ResultSet resultSet(List<String> labels, List<List<String>> rows) {
        AtomicInteger index = new AtomicInteger(-1);
        ResultSetMetaData metadata = proxy(ResultSetMetaData.class,(o,m,a)->switch(m.getName()) {
            case "getColumnCount" -> labels.size();
            case "getColumnLabel" -> labels.get((int)a[0]-1);
            default -> throw new UnsupportedOperationException(m.getName());
        });
        return proxy(ResultSet.class,(o,m,a)->switch(m.getName()) {
            case "getMetaData" -> metadata;
            case "next" -> index.incrementAndGet()<rows.size();
            case "getString" -> rows.get(index.get()).get((int)a[0]-1);
            case "close" -> null;
            default -> throw new UnsupportedOperationException(m.getName());
        });
    }
    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(),new Class<?>[]{type},handler));
    }
}
