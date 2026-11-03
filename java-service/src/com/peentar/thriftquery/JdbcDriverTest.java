package com.peentar.thriftquery;

public final class JdbcDriverTest {
    public static void main(String[] args) throws Exception {
        Class.forName("org.apache.hive.jdbc.HiveDriver");
        System.out.println("Hive JDBC driver loaded");
    }
}
