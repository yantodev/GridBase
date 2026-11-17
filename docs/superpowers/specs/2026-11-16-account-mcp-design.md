# Account-scoped MCP and labeled navigation

## Intent

Add visible DB, History, and Logs labels to the existing icon rail. Provide an actual MCP server for Hermes Agent and Codex CLI, authenticated using account-managed bearer tokens with read_only and full_access scopes. Preserve account ownership and existing workbench behavior.

User-approved design: token settings belong to each GitHub account; both scopes support Spark/Hive, including read-only SQL. Dedicated externally provisioned read-only profiles are mandatory for all database types. User approved implementation with "semua database, lanjut".

## Approaches

1. Recommended: integrate a stateless Streamable HTTP MCP endpoint into the existing Java HTTP/JDBC backend. Reuse ownership, encrypted connection profiles, query limits, and durable activity audit. Clients use configured bearer headers; no OAuth authorization server needed for these two clients.
2. Separate Node/stdio bridge: easier SDK adoption, but adds another deployed process, transport-specific configuration, and an additional credential boundary. Not chosen for a hosted multi-account feature.
3. Frontend-only tool filtering or SELECT-prefix checks: insufficient authorization, particularly with writable CTEs, script transforms, and side-effecting functions. Rejected.

## UI

- Keep existing rail icons; show DB, History, Logs below them. Expand rail width consistently in desktop/mobile layout and resizer calculations; keyboard labels and active/expanded behavior remain accessible. Logs uses the existing Activity view.
- Add an account settings control opening Settings / MCP. Do not add an unrelated global admin panel.
- Token form: name, scope (read_only default), explicitly selected saved connections, expiry (30 days default; choices 30/90/365 days).
- Token list shows name, safe prefix, scope, approved connection names, expiry, and revoked state. Raw tokens appear only in a one-time creation result, are not stored in browser storage, and disappear when closing/reloading/account changes. Copy is an explicit user action.
- Revoke is owner-only; privileges cannot be expanded by editing an existing token. Create a replacement token to rotate/change permissions.
- Bind every connection grant to a non-reusable profile generation and an issuance-time read-only ceiling. Saving/reconnecting with changed profile settings invalidates existing grants for that profile; creating a new profile under a deleted ID cannot revive old grants. An ordinary Connect of unchanged settings does not invalidate grants. Clearing a read-only declaration never upgrades an existing token: the owner must issue a replacement token against the new generation.
- Display the /mcp endpoint and copyable Hermes/Codex configuration templates using an environment-variable placeholder, never interpolating the raw token into durable config examples.
- Extend connection form with an explicit "MCP read-only profile" declaration. The owner confirms this profile uses database/storage credentials provisioned with only read privileges. Default false for all existing profiles. This is an operator assertion, not a proof derived from JDBC.

## Authentication and token storage

- Dedicated SQLite token store under the private application data directory, with schema version checks and private permissions. Use server-generated high-entropy opaque tokens, one-way SHA-256 digest for lookup, stable token ID, account ID/login snapshot, prefix, name, immutable scope, immutable allowlist, expiry, creation/revocation timestamps.
- Never store/log raw bearer tokens, credential fragments, or Authorization headers. Token management APIs require the existing verified browser session, account binding, CSRF/origin protections, and JSON content type. MCP bearer credentials do not authorize token-management, session, profile-edit, audit-admin, or ordinary /api routes.
- Validate bearer authentication on every MCP request, including initialization/list/ping. Reject expired/revoked/foreign tokens before JDBC. Recheck connection ownership and read-only eligibility for every tool call; no trusted client-supplied owner.
- Limit body size, token count per account, and token creation inputs. No query-string tokens. Require HTTPS for remote clients; loopback HTTP is allowed for local development. Validate an incoming Origin against configured APP_URL and reject cross-site browser use.
- Builder limits: 20 active tokens per account, 64 KiB JSON request body, 20,000 SQL characters, 500 result rows, 1,000 metadata entries, and 1 MiB serialized tool response. Return explicit truncation information. Apply configured query timeout and a bounded MCP executor/concurrency limit; connection establishment, metadata and query waiting must have finite deadlines. Configure driver-supported connect/socket timeouts, clean up late connections/results, and document that cancelling a request cannot guarantee that an uncooperative JDBC driver stops server-side work.
- Dedicated /mcp routing authenticates bearer credentials before the ordinary cookie-auth route; cookie-only requests never authenticate to MCP. Missing Origin is allowed for CLI clients, but a present Origin must equal APP_URL. Treat the app listener as plaintext behind a trusted TLS-terminating reverse proxy; APP_URL alone is not TLS. Do not trust arbitrary X-Forwarded-* headers to infer secure transport. Require APP_URL HTTPS in non-loopback deployments and document the private proxy-to-app hop.

## MCP protocol and tools

- /mcp supports JSON-RPC 2.0 Streamable HTTP using JSON responses; initialize, notifications/initialized, ping, tools/list and tools/call. No SSE stream/session storage is needed; authenticated GET returns 405 with Allow. Validate protocol/version and message shapes using a real JSON parser, not the existing flat field search helper for nested MCP input.
- Support protocol versions 2025-03-26, 2025-06-18 and 2025-11-25, negotiating the requested supported version or 2025-11-25 during initialize. Validate MCP-Protocol-Version on subsequent requests, assuming 2025-03-26 when omitted as specified by the transport. Require appropriate Accept/Content-Type, respond 202 with no body to accepted notifications, reject batches and malformed/duplicate-key JSON, preserve string/integer request IDs, map protocol errors to JSON-RPC errors, and return tool execution failures as isError results rather than reporting success based on HTTP 200. Unknown methods use -32601; malformed requests/params use -32600/-32602; parsing uses -32700. No SSE, OAuth discovery, resources or prompts are advertised.
- Pin Gson 2.13.2 for strict nested JSON handling and JSqlParser 5.3 for SQL AST inspection; do not imply these are the latest releases. Add reproducible checksum-verified dependency downloads and explicit compile/test/runtime classpaths in native scripts and Docker. Validate dependencies against Java 17 before adoption; no reflection-based fallback into the flat JsonUtil parser.
- Tools: list_connections, list_databases, list_tables, describe_table, execute_query. Names/schemas/annotations reflect scope. Full access means SQL read/write within the token's selected account-owned connections, NOT administrative API access or credential disclosure.
- Require explicit connectionId for database tools; no default or foreign-ID fallback. List only approved connections and safe metadata.
- MCP operates on the explicitly approved saved profiles, independently of the workbench's transient Connected status. Each call opens/closes its own JDBC connection. This supports AI after application restart without a browser Connect step; the UI must explain that workbench Disconnect is not token revocation. Revoke the token/remove the profile grant by replacing the token/delete the profile to stop MCP access.
- full_access accepts the same single-statement SQL policy as the workbench. Database permissions still apply. No browser confirmation can protect a remote tool call; tool annotations and docs warn that the AI client must request approval for writes.
- Use existing timeouts and bounded response rows, with an MCP hard row cap independent of explicit SQL LIMIT. Do not silently retry SQL after an uncertain outcome.
- Add an immutable per-call JDBC execution policy carrying profile generation, scope/read-only ceiling, row cap, and deadline. Apply it consistently to queries and metadata, using explicit saved-profile lookup rather than ConnectionRegistry.require/default connection fallback. Existing workbench execution remains unchanged.

## Read-only policy

- read_only tokens can select only profiles marked MCP read-only. If a profile is deleted, becomes foreign, or is edited (including credentials), its read-only declaration must be reconfirmed; a token cannot bypass the current eligibility check. Full-access tokens selecting a read-only profile must still respect the profile's read-only policy rather than upgrading it.
- Dedicated externally provisioned read-only profiles are mandatory for PostgreSQL/MySQL as well as Spark/Hive (user-approved).
- Allow SELECT, read-only WITH/CTEs, and explicitly supported metadata operations. Validate the whole statement structurally, including nested CTEs/subqueries and dialect quoting/comments. Reject unparseable/unsupported constructs rather than falling back to full access.
- Reject DDL/DML, writable CTEs, multiple statements, SELECT INTO/OUTFILE, locking clauses, EXPLAIN ANALYZE of writes, Spark/Hive TRANSFORM/MAP/REDUCE scripts, session/resource/extension commands, and functions outside a conservative built-in read-function allowlist. Keep quoted identifiers/literals separate from SQL code. Do not treat all WITH or all SELECT as safe.
- PostgreSQL/MySQL: additionally request enforced database read-only transaction semantics, fail closed when the read-only setup fails, rollback/close after execution. This is additional protection, not permission verification.
- Spark/Hive: do not rely on setReadOnly(true) or rollback; installed Hive JDBC does not support them. Use the dedicated read-only database/storage identity and strict application policy. Production privileges and side effects of administrator-controlled UDFs cannot be proven by GridBase. Do not execute a production write probe to verify permissions.
- Document this trust boundary clearly; the UI declaration cannot create database grants. The operator configures Hive authorization or the actual Spark deployment's catalog/storage permissions externally.
- Accepted query subset: ordinary SELECT projections, predicates, joins, grouping, ordering, limits, read-only subqueries/CTEs, set operations and conservative built-in aggregates/scalar functions. Use AST visitors with explicit node/function allowlists, including a documented Spark/Hive intersection, and reject unsupported syntax. Do not promise that a function-name allowlist proves arbitrary database objects are side-effect free: views, functions, custom operators/casts, storage handlers and name resolution are trusted database administration. Actual database/storage permissions remain the security boundary.

## Audit

- Log MCP metadata/query operations with verified account, token ID/name (not secret), connection, SQL text for query events, outcome, duration and counts. Distinguish source mcp from server/browser in APIs/UI and retain ordinary Activity owner/admin visibility.
- Durable pending intent and SQL annotation precede JDBC. Audit failure before JDBC blocks the call; completion-write failure preserves the actual tool result plus a visible audit-incomplete indication, without implying the SQL failed.
- Token creation/revocation activity excludes raw token response/body and bearer credentials. Token responses use no-store and clear frontend state on close/account change.
- Extend the audit schema for token ID/name and source=mcp. Use explicit per-tool lifecycle events/outcomes rather than the existing HTTP-status completion wrapper: MCP tool failures can have HTTP 200. Include requestId and auditIncomplete in tool-result metadata/content in addition to any HTTP header, preserving actual successful query results when final audit persistence fails.

## Compatibility, rollout and version

- Java backend only; legacy Node explicitly rejects MCP/token APIs with 501 rather than authenticating bearer tokens as browser sessions.
- Existing profiles, drafts, GitHub sessions, Logs access, and SQL workbench remain compatible; no automatic privilege migration.
- Prepare MINOR 1.3.0 metadata and release notes once implementation passes. Do not commit/push/restart/install client configuration or create a public endpoint unless separately requested. On an eventual authorized master push, existing release automation handles tag/Release.

## Verification

- TDD for token persistence/expiry/revocation/account isolation and no plaintext token on disk/logs; real SQLite and HTTP fixtures.
- SQL policy tests for all supported dialects, normal SELECT/joins/CTEs/aggregates, malicious nested/writable/script/function cases, and fail-closed unsupported syntax.
- JDBC tests show read-only setup before user SQL, no fallback on failed setup, cleanup and row/time limits; Spark read-only does not call unsupported flags.
- HTTP/MCP tests for initialization/discovery/calls/errors/notifications, invalid protocol/auth/origin, explicit connection allowlist, foreign IDs before JDBC, scope changes/revocation, saved disconnected profiles, and durable audit outcomes.
- Cover profile revision changes, delete/recreate ID, issuance-time read-only ceiling, credential changes after token creation, disconnected profile access and timeout cleanup without leaking worker capacity. Preserve existing Spark/Hive s3tables catalog behavior; arbitrary catalog discovery is not added implicitly.
- Real MCP SDK client compatibility probe with dummy profiles (no live secrets or external databases); verify Hermes/Codex configuration shapes against current docs/CLI. Do not install into the user's live agent configuration.
- UI/controller tests for rail labels/layout state, token create/revoke/default scope, one-time secret clearing, account-switch stale responses and safe rendering.
- Run full npm test, npm run check, YAML/OpenAPI validation, git diff --check and independent focused security/correctness review before completion. Report which real-client/live-database checks could not be executed.
