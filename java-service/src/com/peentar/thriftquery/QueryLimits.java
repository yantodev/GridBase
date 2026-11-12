package com.peentar.thriftquery;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Separates the SQL result limit from the browser's ten-row pagination. */
final class QueryLimits {
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z_][A-Za-z0-9_$]*|[()]");
    private static final Pattern VALUE = Pattern.compile("(?is)^\\s*(?:NULL\\b|ALL\\b|CASE\\b|[+-]?\\d|\\(|[A-Za-z_][A-Za-z0-9_$]*\\s*\\()");
    private static final Pattern NULL_VALUE = Pattern.compile("(?i)^\\s*NULL\\b");
    private record Token(String word, int start, int end) { }

    static Plan plan(String sql, int defaultLimit) {
        String masked = SqlPolicy.maskQuotedSql(sql);
        List<Token> words = new ArrayList<>();
        Matcher tokens = TOKEN.matcher(masked);
        int depth = 0;
        while (tokens.find()) {
            String token = tokens.group();
            if (token.equals("(")) depth++;
            else if (token.equals(")")) depth--;
            else if (depth == 0) words.add(new Token(token.toUpperCase(java.util.Locale.ROOT), tokens.start(), tokens.end()));
        }
        if (words.isEmpty()) return new Plan(sql, defaultLimit);
        String command = words.get(0).word();
        if (command.equals("WITH")) {
            command = words.stream().map(Token::word)
                    .filter(word -> word.matches("SELECT|INSERT|UPDATE|DELETE|MERGE")).findFirst().orElse("");
        }
        if (!command.equals("SELECT")) return new Plan(sql, defaultLimit);
        for (int i = words.size() - 1; i > 0; i--) {
            Token word = words.get(i);
            if (!word.word().equals("LIMIT")) continue;
            Token previous = words.get(i-1);
            if (previous.word().matches("SELECT|FROM|JOIN|AS|WHERE|AND|OR|ON|BY|INTO|TABLE|UPDATE")
                    && masked.substring(previous.end(), word.start()).isBlank()) continue;
            String before = masked.substring(0, word.start()).stripTrailing();
            if (!before.isEmpty() && ".,><=!+-*/%".indexOf(before.charAt(before.length()-1)) >= 0) continue;
            if (words.subList(i+1, words.size()).stream().anyMatch(t -> t.word().matches(
                    "SELECT|FROM|WHERE|GROUP|HAVING|ORDER|UNION|INTERSECT|EXCEPT|JOIN|LATERAL|WINDOW|QUALIFY|AS|ASC|DESC|NULLS|FIRST|LAST|INSERT|UPDATE|DELETE|MERGE"))) continue;
            String value = masked.substring(word.end());
            if (!VALUE.matcher(value).find()) continue;
            Matcher nullValue = NULL_VALUE.matcher(value);
            if (nullValue.find()) {
                int start = word.end() + nullValue.end() - 4;
                return new Plan(sql.substring(0, start) + defaultLimit + sql.substring(start + 4), defaultLimit);
            }
            return new Plan(sql, Integer.MAX_VALUE);
        }
        return new Plan(sql, defaultLimit);
    }

    record Plan(String sql, int rowLimit) { }
}
