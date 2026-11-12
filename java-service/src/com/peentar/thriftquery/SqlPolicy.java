package com.peentar.thriftquery;

import java.util.regex.Pattern;
import java.util.regex.Matcher;

public final class SqlPolicy {
    private static final Pattern SQL_QUOTE_OR_COMMENT = Pattern.compile(
            "'(?:''|\\\\[\\s\\S]|[^'\\\\])*+'|\"(?:\"\"|\\\\[\\s\\S]|[^\"\\\\])*+\"|`(?:``|[^`])*+`|/\\*[\\s\\S]*?\\*/|--[^\\r\\n]*");
    private static final Pattern SQL_START = Pattern.compile(
            "^(select|with|show|describe|desc|explain|create|insert|update|delete|merge|alter|drop|truncate)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern CLIENT_COMMAND = Pattern.compile("(^|\\n)\\s*!");

    private SqlPolicy() {
    }

    static String maskQuotedSql(String sql) {
        Matcher tokens = SQL_QUOTE_OR_COMMENT.matcher(sql);
        StringBuilder masked = new StringBuilder();
        while (tokens.find()) {
            String token = tokens.group();
            String marker = token.startsWith("/*") || token.startsWith("--") ? " " : "?";
            tokens.appendReplacement(masked, Matcher.quoteReplacement(marker.repeat(token.length())));
        }
        tokens.appendTail(masked);
        return masked.toString();
    }

    public static Result validate(String input, int maxLength) {
        if (input == null) return Result.invalid("Query harus berupa teks.");
        if (input.length() > maxLength) return Result.invalid("Query terlalu panjang.");
        if (input.indexOf('\0') >= 0) return Result.invalid("Query mengandung karakter yang tidak valid.");

        Matcher tokens = SQL_QUOTE_OR_COMMENT.matcher(input);
        StringBuilder uncommented = new StringBuilder();
        while (tokens.find()) {
            String token = tokens.group();
            tokens.appendReplacement(uncommented, Matcher.quoteReplacement(
                    token.startsWith("/*") || token.startsWith("--") ? " " : token));
        }
        tokens.appendTail(uncommented);
        String sql = uncommented.toString()
                .replaceFirst(";\\s*$", "")
                .trim();
        if (sql.isEmpty()) return Result.invalid("Query tidak boleh kosong.");
        String code = SQL_QUOTE_OR_COMMENT.matcher(sql).replaceAll("?");
        if (code.contains(";") || CLIENT_COMMAND.matcher(code).find()) {
            return Result.invalid("Jalankan satu perintah SQL dalam satu query.");
        }
        if (!SQL_START.matcher(code).find()) {
            return Result.invalid("Perintah SQL tidak didukung. Gunakan query data atau perintah CREATE, INSERT, UPDATE, DELETE, MERGE, ALTER, DROP, atau TRUNCATE.");
        }
        return Result.valid(sql);
    }

    public record Result(boolean ok, String sql, String error) {
        static Result valid(String sql) {
            return new Result(true, sql, null);
        }

        static Result invalid(String error) {
            return new Result(false, null, error);
        }
    }
}
