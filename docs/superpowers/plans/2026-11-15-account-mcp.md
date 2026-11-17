# Account-scoped MCP Implementation Plan

> For agentic workers: use test-driven-development and explicit file ownership; integrate and review the complete branch before reporting completion.

Goal: ship account-scoped Streamable HTTP MCP with immutable token grants and labeled navigation.

Architecture: Java HTTP backend owns bearer authentication, token management, audit and bounded JDBC execution. Browser settings manage tokens using the existing account-bound cookie session. MCP never routes through browser authentication.

Tech Stack: Java 17, SQLite, Gson 2.13.2, JSqlParser 5.3, browser JavaScript and Node tests.

Spec: docs/superpowers/specs/2026-11-16-account-mcp-design.md

## Global Constraints

- Dedicated externally provisioned read-only profiles for all database types; legacy profiles default false.
- Token grants bind a non-reusable saved-profile generation plus issuance-time read-only ceiling.
- Limits: 20 active tokens/account, 64 KiB request, 20,000 SQL characters, 500 rows, 1,000 metadata entries, 1 MiB response.
- Preserve ordinary workbench semantics and current Spark/Hive s3tables catalog.
- No live credential reads, production write probes, client installation/config edits, commit, push or service restart.
- Prepare 1.3.0 only after implementation checks pass.

## Review Focus

- Same-ID profile deletion/recreation cannot revive an old token.
- Delayed browser requests cannot restore a secret after dialog close/account change.
- HTTP 200 tool failures must not be audited as successful SQL.
- Explicit SQL LIMIT cannot bypass the independent MCP result cap.
- JDBC timeout must not release capacity while an uncooperative worker is still running.

## Task 1: Saved profile generations and opaque token persistence

Files: ConnectionSettings.java, ConnectionRegistry.java, new McpTokenStore.java and corresponding Java tests.

Interfaces:
- ConnectionRegistry.mcp(String id) returns McpProfile(id, generation, readOnly, service), using only an explicit saved profile, connected or not.
- ConnectionSettings.mcpReadOnly() is false for old data; ConnectionSettings.generation() persists a random UUID. Changed settings create a new generation; unchanged reconnect retains it.
- McpTokenStore(Path directory) owns private mcp.sqlite.
- McpTokenStore.Grant(String connectionId, String generation, boolean readOnly).
- McpTokenStore.Token(String id, String ownerId, String login, String name, String prefix, String scope, List<Grant> grants, long createdAt, long expiresAt, Long revokedAt), with safe toJson().
- McpTokenStore.Created(Token token, String secret).
- create(GitHubAuth.User user, String name, String scope, int expiresInDays, List<Grant> grants), authenticate(String secret), list(String ownerId), revoke(String ownerId, String tokenId).

- [x] Write and observe failing tests for persistence, hash-only storage, expiry, owner isolation, immutable grants, profile edit/recreate invalidation and unchanged reconnect.
- [x] Implement generation persistence and private hash-only token storage with explicit field validation.
- [x] Run focused Java tests and preserve red/green evidence.

## Task 2: Conservative SQL and bounded JDBC execution

Files: new McpSqlPolicy.java, new McpExecutionPolicy.java, JdbcService.java, new McpJdbcTest.java / McpSqlPolicyTest.java.

Interfaces:
- McpSqlPolicy.validate(String sql, DatabaseType type) throws IllegalArgumentException for non-read-only/unsupported statements.
- McpExecutionPolicy(String generation, boolean readOnly, int rowLimit, int metadataLimit, long deadlineNanos).
- JdbcService.forMcp(McpExecutionPolicy policy) returns an immutable execution-policy view; existing query/databases/tables/columns methods are reused without changing normal workbench behavior.
- MCP view applies row/metadata caps and driver setup/cleanup to every path; caller applies bounded worker deadlines.

- [x] Write and observe failing tests for safe SELECT/CTE/set operations, nested writes, scripts/locking/output/functions and unsupported AST.
- [x] Add AST/function allowlists; fail closed and preserve dialect string/identifier boundaries.
- [x] Write failing JDBC tests for policy setup, hard caps with LIMIT, rollback and Hive flag avoidance; implement and pass them.

## Task 3: MCP routing, token APIs and durable audit

Files: new StrictJson.java, McpApi.java, McpServer.java; ThriftQueryServer.java, AuditStore.java, ActivityAudit.java; build/dependency scripts and Dockerfile.

Interfaces:
- GET /api/mcp/tokens returns {tokens,connections,endpoint}; connections contain id/name/type/mcpReadOnly only.
- POST /api/mcp/tokens accepts {name,scope,expiresInDays,connectionIds}; returns {token,secret} once, no-store.
- DELETE /api/mcp/tokens/{id} revokes only the authenticated owner's token.
- /mcp is dedicated bearer-only transport; supports initialize, initialized notification, ping, tools/list and tools/call for list_connections/list_databases/list_tables/describe_table/execute_query.
- Explicit MCP audit lifecycle carries tokenId/tokenName and source=mcp. Pending intent precedes JDBC; final-audit failure preserves successful data with auditIncomplete/requestId.

- [x] Add checksum-pinned dependencies to all compile/test/runtime paths.
- [x] Write strict JSON and real HTTP tests, observe failures, implement protocol/auth/content/version/origin checks and management APIs.
- [x] Add explicit audit events/schema migration and tests for HTTP-200 failures and no token disclosure.
- [x] Test finite deadlines with bounded workers; saturated capacity rejects rather than queues indefinitely.

## Task 4: Labeled rail and account MCP settings

Files: public/index.html, public/styles.css, public/app.js, new public/mcp.js and test/mcp.test.js.

- [x] Write and observe failing tests for DB/History/Logs, default read_only, explicit connection selection, create/revoke, one-time token clearing and stale account/dialog responses.
- [x] Implement safe text rendering and explicit copy action; no raw token in storage/config templates.
- [x] Wire connection mcpReadOnly declaration and safe list/settings state. Explain externally provisioned privileges and disconnect != revoke.
- [x] Verify UI tests and existing controller tests.

## Task 5: Documentation, interoperability and release preparation

Files: README.md, openapi.yaml, VERSION/package.json via version script, docs/releases/V1.3.0.md, legacy server.js.

- [x] Explicitly reject MCP/token APIs in legacy Node mode.
- [x] Document trust boundary, supported SQL subset/functions, finite deadlines, reverse proxy TLS and Hermes/Codex environment-token configuration from current official docs.
- [x] Exercise actual MCP SDK against dummy fixture; no production database or live client configuration.
- [x] Run npm test, npm run check, OpenAPI/YAML validation and git diff --check; then bump 1.3.0 and re-run gates.
- [x] Independent whole-branch security/correctness review, fix blocking defects with red/green tests and repeat full gates.

Execution: user explicitly approved continuation; implement without another design-approval round. Work stays uncommitted on feature/account-mcp.
