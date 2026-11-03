package com.peentar.thriftquery;

import java.util.regex.Pattern;

public final class SqlPolicy {
    private static final Pattern BLOCK_COMMENT = Pattern.compile("/\\*[\\s\\S]*?\\*/");
    private static final Pattern LINE_COMMENT = Pattern.compile("--[^\\r\\n]*");
    private static final Pattern READ_ONLY_START = Pattern.compile(
            "^(select|with|show|describe|desc|explain)\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern MUTATION_WORD = Pattern.compile(
            "\\b(insert|update|delete|drop|alter|truncate|create|merge|grant|revoke|msck|load|set|reset|use)\\b",
            Pattern.CASE_INSENSITIVE);

    private SqlPolicy() {
    }

    public static Result validate(String input, int maxLength) {
        if (input == null) return Result.invalid("Query harus berupa teks.");

        String sql = LINE_COMMENT.matcher(BLOCK_COMMENT.matcher(input).replaceAll(" ")).replaceAll(" ")
                .replaceFirst(";\\s*$", "")
                .trim();
        if (sql.isEmpty()) return Result.invalid("Query tidak boleh kosong.");
        if (sql.length() > maxLength) return Result.invalid("Query terlalu panjang.");
        if (sql.indexOf('\0') >= 0) return Result.invalid("Query mengandung karakter yang tidak valid.");
        if (!READ_ONLY_START.matcher(sql).find()) {
            return Result.invalid("Mode aman hanya mengizinkan SELECT, WITH, SHOW, DESCRIBE, dan EXPLAIN.");
        }
        if (MUTATION_WORD.matcher(sql).find()) {
            return Result.invalid("Query perubahan data diblokir karena workbench berjalan dalam mode read-only.");
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
