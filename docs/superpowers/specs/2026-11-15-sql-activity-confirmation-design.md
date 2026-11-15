# SQL activity and mutation confirmation

## Intent and scope

Store the SQL submitted for query.execute activity and display it in Activity details. Ask for confirmation before executing UPDATE or DELETE through the workbench, including selected SQL and keyboard execution.

## Approach

Extend the existing Java audit event with nullable sqlText, persisted before JDBC alongside its fingerprint. Migrate audit SQLite schema 1 to 2 transactionally without dropping history. Historical and non-query events have null SQL text. Keep existing owner/admin authorization and private file permissions. SQL text may contain sensitive literals; document this explicitly. Connection credentials, errors, OAuth material, and result rows remain excluded.

Use the browser's existing native confirmation pattern rather than introducing an asynchronous modal state machine. Tokenize the SQL actually selected for execution, ignoring comments and quoted text. Detect UPDATE/DELETE statements, including mutations after WITH and inside data-modifying CTEs. Cancellation sends no request and preserves results/history; acceptance sends the original SQL to the originating connection. Read-only SELECT (including FOR UPDATE), EXPLAIN, and literal/comment mentions require no confirmation.

## Alternatives

A dedicated dialog provides richer styling but adds unnecessary state and focus handling for this small change. A regex-only leading-verb check is smaller but misses CTE mutations. Retain existing UI, tokenizer, and dependencies.

## Non-goals

No API-level confirmation protocol, other destructive command prompts, historical SQL reconstruction, credentials logging, version bump, commit, push, or deployment restart.

## Verification

Real HTTP/SQLite tests for SQL persistence, restart, migration, owner/admin isolation, and unrelated secret exclusion. Controller tests for safe SQL detail rendering, selected/current statements, acceptance/cancellation, and keyboard execution. Full npm run test and npm run check.
