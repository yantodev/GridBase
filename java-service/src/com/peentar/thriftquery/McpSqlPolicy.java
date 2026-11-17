package com.peentar.thriftquery;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import net.sf.jsqlparser.expression.Function;
import net.sf.jsqlparser.parser.CCJSqlParserUtil;
import net.sf.jsqlparser.statement.Statement;
import net.sf.jsqlparser.statement.select.Select;

/**
 * Deliberately small, fail-closed read-only SQL intersection for PG, MySQL and Hive.
 * This does not prove that database views, operators or administrator-defined objects
 * are harmless: externally provisioned read-only credentials remain mandatory.
 * Casts, windows, table functions, scripts, hints and qualified/quoted functions are
 * intentionally unsupported. No SQL is rewritten or executed by this validator.
 */
public final class McpSqlPolicy {
    private static final String ROOT = "net.sf.jsqlparser.";
    private static final Set<String> FUNCTIONS = Set.of(
            "count", "sum", "avg", "min", "max", "abs", "ceil", "ceiling", "floor",
            "round", "sqrt", "power", "mod", "coalesce", "nullif", "lower", "upper",
            "length", "char_length", "character_length", "concat", "concat_ws",
            "substring", "substr", "trim", "ltrim", "rtrim", "replace", "greatest", "least");
    /* Explicit AST class + field allowlist, not a permissive base-class visitor.
     * Fields not listed MUST be empty/default. Registering a class never permits a
     * subclass, and parser bookkeeping is the only ignored superclass. This also
     * rejects previously unknown non-default fields when upgrading JSqlParser.
     */
    private static final Map<String, Set<String>> FIELDS = fields();
    private static final java.util.concurrent.atomic.AtomicInteger THREAD_ID = new java.util.concurrent.atomic.AtomicInteger();
    private static final java.util.concurrent.ExecutorService PARSERS = new java.util.concurrent.ThreadPoolExecutor(
            2, 2, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, new java.util.concurrent.ArrayBlockingQueue<>(2), task -> {
                Thread thread = new Thread(task, "mcp-sql-parser-" + THREAD_ID.incrementAndGet());
                thread.setDaemon(true);
                return thread;
            }, new java.util.concurrent.ThreadPoolExecutor.AbortPolicy());

    private McpSqlPolicy() { }

    public static void validate(String sql, DatabaseType type) {
        if (type == null || sql == null || sql.isBlank() || sql.length() > 20_000)
            throw invalid();
        lexicalBoundary(sql, type);
        try {
            // JSqlParser's timeout uses Future.get and its interrupted flag. Share
            // a fixed daemon pool + bounded queue: pathological parses cannot
            // create threads or release capacity before the parser really exits.
            var parser = CCJSqlParserUtil.newParser(sql).withAllowComplexParsing(false).withTimeOut(1000L);
            List<Statement> statements = CCJSqlParserUtil.parseStatements(parser, PARSERS);
            if (statements.size() != 1 || !(statements.get(0) instanceof Select)) throw invalid();
            new Walker().visit(statements.get(0), 0);
        } catch (IllegalArgumentException failure) {
            throw failure;
        } catch (Exception | LinkageError | StackOverflowError failure) {
            throw invalid();
        }
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Unsupported or non-read-only MCP SQL; use the documented SELECT subset.");
    }

    private static Map<String, Set<String>> fields() {
        Map<String, Set<String>> result = new HashMap<>();
        put(result, "statement.select.Select", "withItemsList limit offset orderByElements alias");
        put(result, "statement.select.PlainSelect", "distinct selectItems fromItem joins where groupBy having");
        put(result, "statement.select.ParenthesedSelect", "select alias");
        put(result, "statement.select.SetOperationList", "selects operations orderByElements");
        put(result, "statement.select.SetOperation", "type");
        for (String name : List.of("UnionOp", "IntersectOp", "ExceptOp"))
            put(result, "statement.select." + name, "distinct all");
        put(result, "statement.select.WithItem", "statement alias withItemList recursive");
        put(result, "statement.select.SelectItem", "expression alias");
        put(result, "statement.select.Join", "onExpressions usingColumns outer right left natural full inner simple cross fromItem");
        put(result, "statement.select.GroupByElement", "groupByExpressions");
        put(result, "statement.select.OrderByElement", "expression asc ascDescPresent nullOrdering");
        put(result, "statement.select.Distinct", "onSelectItems");
        put(result, "statement.select.Limit", "rowCount offset");
        put(result, "statement.select.Offset", "offsetExpression offsetParam");
        put(result, "statement.select.AllColumns", "");
        put(result, "statement.select.AllTableColumns", "table");
        put(result, "schema.Table", "partItems partDelimiters alias");
        put(result, "schema.Column", "table columnName tableDelimiter");
        put(result, "expression.Alias", "name useAs");
        put(result, "expression.Function", "nameparts parameters allColumns distinct");
        put(result, "expression.TrimFunction", "trimSpecification expression fromExpression isUsingFromKeyword");
        put(result, "expression.LongValue", "stringValue");
        put(result, "expression.DoubleValue", "value stringValue");
        put(result, "expression.StringValue", "value");
        put(result, "expression.NullValue", "");
        put(result, "expression.BooleanValue", "value");
        put(result, "expression.CaseExpression", "usingBrackets switchExpression whenClauses elseExpression");
        put(result, "expression.WhenClause", "whenExpression thenExpression");
        put(result, "expression.NotExpression", "expression");
        put(result, "expression.SignedExpression", "sign expression");
        put(result, "expression.BinaryExpression", "leftExpression rightExpression");
        for (String name : List.of("Addition", "Subtraction", "Multiplication", "Division", "Modulo", "Concat"))
            put(result, "expression.operators.arithmetic." + name, "");
        for (String name : List.of("AndExpression", "OrExpression"))
            put(result, "expression.operators.conditional." + name, "");
        put(result, "expression.operators.relational.OldOracleJoinBinaryExpression", "");
        put(result, "expression.operators.relational.ComparisonOperator", "operator");
        for (String name : List.of("EqualsTo", "NotEqualsTo", "GreaterThan", "GreaterThanEquals", "MinorThan", "MinorThanEquals"))
            put(result, "expression.operators.relational." + name, "");
        put(result, "expression.operators.relational.Between", "leftExpression not betweenExpressionStart betweenExpressionEnd");
        put(result, "expression.operators.relational.InExpression", "leftExpression not rightExpression");
        put(result, "expression.operators.relational.ExistsExpression", "rightExpression not");
        put(result, "expression.operators.relational.IsNullExpression", "leftExpression not");
        put(result, "expression.operators.relational.LikeExpression", "not escapeExpression likeKeyWord");
        return Map.copyOf(result);
    }

    private static void put(Map<String, Set<String>> target, String name, String fields) {
        target.put(ROOT + name, fields.isEmpty() ? Set.of() : Set.of(fields.split(" ")));
    }

    private static final class Walker {
        private int nodes;

        void visit(Object value, int depth) throws IllegalAccessException {
            if (value == null) return;
            if (++nodes > 12_000 || depth > 128) throw invalid();
            Class<?> type = value.getClass();
            if (value instanceof String || value instanceof Number || value instanceof Boolean
                    || value instanceof Character || type.isEnum()) return;
            if (value instanceof Iterable<?> list) {
                String name = type.getName();
                if (!(name.startsWith("java.util.") || name.equals(ROOT + "expression.operators.relational.ExpressionList")
                        || name.equals(ROOT + "expression.operators.relational.ParenthesedExpressionList"))) throw invalid();
                for (Object item : list) visit(item, depth + 1);
                return;
            }
            if (!FIELDS.containsKey(type.getName())) throw invalid();
            if (value instanceof Function function) {
                String name = function.getName();
                if (function.getMultipartName().size() != 1 || name == null
                        || !name.matches("[A-Za-z_]+") || !FUNCTIONS.contains(name.toLowerCase(Locale.ROOT))) throw invalid();
            }
            for (Class<?> current = type; current != Object.class; current = current.getSuperclass()) {
                if (current.getName().equals(ROOT + "parser.ASTNodeAccessImpl")) continue;
                Set<String> allowed = FIELDS.get(current.getName());
                if (allowed == null) throw invalid();
                for (Field field : current.getDeclaredFields()) {
                    if (Modifier.isStatic(field.getModifiers()) || field.isSynthetic()) continue;
                    field.setAccessible(true);
                    Object child = field.get(value);
                    if (allowed.contains(field.getName())) visit(child, depth + 1);
                    else if (!empty(child)) throw invalid();
                }
            }
        }

        private boolean empty(Object value) {
            return value == null || Boolean.FALSE.equals(value) || value instanceof Number n && n.doubleValue() == 0
                    || value instanceof java.util.Collection<?> collection && collection.isEmpty();
        }
    }

    /** Guard parser/server lexical differences, not a SELECT-prefix security test. */
    private static void lexicalBoundary(String sql, DatabaseType type) {
        int depth = 0;
        int tokens = 0;
        boolean ended = false;
        for (int i = 0; i < sql.length(); i++) {
            char c = sql.charAt(i);
            if (Character.isWhitespace(c)) continue;
            if (c == '\0' || c == '\\' || c == '$' || c == '#') throw invalid();
            if (c == '-' && i + 1 < sql.length() && sql.charAt(i + 1) == '-') {
                if (type == DatabaseType.MYSQL && i + 2 < sql.length() && !Character.isWhitespace(sql.charAt(i + 2))) throw invalid();
                while (i + 1 < sql.length() && sql.charAt(i + 1) != '\n' && sql.charAt(i + 1) != '\r') i++;
                continue;
            }
            if (c == '/' && i + 1 < sql.length() && sql.charAt(i + 1) == '*') {
                int end = sql.indexOf("*/", i + 2);
                if (end < 0) throw invalid();
                String comment = sql.substring(i + 2, end);
                if (comment.startsWith("!") || comment.startsWith("+") || comment.toLowerCase(Locale.ROOT).startsWith("m!")
                        || comment.contains("/*")) throw invalid();
                i = end + 1;
                continue;
            }
            if (ended || ++tokens > 4_000) throw invalid();
            if (c == '\'' || c == '"' || c == '`') {
                if (c == '`' && type == DatabaseType.POSTGRESQL) throw invalid();
                char quote = c;
                boolean closed = false;
                while (++i < sql.length()) {
                    c = sql.charAt(i);
                    if (c == '\\' || c == '\0') throw invalid();
                    if (c == quote) {
                        if (i + 1 < sql.length() && sql.charAt(i + 1) == quote) { i++; continue; }
                        closed = true;
                        break;
                    }
                }
                if (!closed) throw invalid();
            } else if (c == '(') {
                if (++depth > 64) throw invalid();
            } else if (c == ')') {
                if (--depth < 0) throw invalid();
            } else if (c == ';') {
                if (depth != 0) throw invalid();
                ended = true;
            }
        }
        if (depth != 0) throw invalid();
    }
}
