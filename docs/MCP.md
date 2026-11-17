# GridBase MCP: Hermes Agent and Codex CLI

GridBase's **Java backend** serves an account-scoped MCP endpoint at
`<APP_URL>/mcp`. It lets an AI client discover approved saved connections,
inspect metadata, and execute SQL within the token's permissions. The legacy
Node backend does not provide MCP or token management (it returns `501`).

**Start with `read_only`, dedicated read-only credentials, and a small explicit
connection selection.** `full_access` can change or destroy database data; the
workbench's UPDATE/DELETE confirmation dialog does not run for remote MCP calls.

## 1. Prepare saved profiles and issue a token

1. Sign in to GridBase with your GitHub account. Save the database connections
   you want the agent to use. A workbench **Connect** session is not required.
2. For read-only use, ask your database/platform administrator to provision a
   **separate identity with only the required read privileges**, then save a
   dedicated connection using those credentials. This is required for
   **PostgreSQL, MySQL, and Spark Thrift / Hive**, not just Spark/Hive.
3. In the connection form, explicitly confirm **MCP read-only profile** only
   after provisioning those database/catalog/storage permissions. Existing
   profiles start with this declaration off. The checkbox records your assertion;
   it does not create grants or prove that the credentials are read-only.
4. Open the account's **Settings / MCP**. Enter a descriptive token name, choose
   `read_only` (the default) or `full_access`, and **explicitly select the saved
   connections** it may access. There is no implicit all-connections or default
   connection grant. A `read_only` token can select only declared read-only profiles.
5. Choose an expiry of **30 days** (default), **90 days**, or **365 days** and
   create the token. An account may have at most **20 active tokens**.
6. Copy the raw token from the one-time result into your approved secret store
   or the client environment described below. Closing/reloading the result or
   changing accounts clears it; the token list cannot reveal it again. If lost,
   revoke it and create a replacement.
7. Copy the endpoint shown in Settings / MCP. Replace
   `https://gridbase.example/mcp` in the examples with that exact URL.

The token belongs to the issuing GitHub account and grants only the selected
account-owned profiles. The client cannot supply another owner or obtain profile
passwords/JDBC credentials. A bearer token is **not** a GitHub token and cannot
manage tokens, edit profiles, read administrative APIs, or authenticate ordinary
GridBase `/api` requests. Token management requires the owner's browser session.

| Scope | Effective access |
| --- | --- |
| `read_only` | Supported read-only SQL and metadata on the selected, still-eligible dedicated read-only profiles. |
| `full_access` | The workbench's supported single-statement SQL read/write policy, limited by the selected profiles and database privileges. No administrative API or credential-disclosure rights. |

A read-only profile remains read-only even when selected by a `full_access`
token. The issuance-time read-only ceiling cannot be upgraded by clearing a
checkbox later. Client-side tool filtering and tool annotations are convenience
and approval signals, **not substitutes for server authorization or database
permissions**.

## 2. Put the token in the client environment

Use the same variable name in the following examples:

```text
GRIDBASE_MCP_TOKEN
```

Its value is the **raw token only**, with no `Bearer ` prefix, quotes copied from
a JSON response, or trailing whitespace. Never put the raw value in a URL,
repository, issue, chat prompt, screenshot, command-line argument, or durable
YAML/TOML example. Do not enable shell tracing or log Authorization headers.

For a temporary Bash session, prompt without saving the value in shell history:

```bash
read -rsp 'GridBase MCP token: ' GRIDBASE_MCP_TOKEN
printf '\n'
export GRIDBASE_MCP_TOKEN
```

Launch the intended client from that shell. Environment variables belong to a
process: an already-running CLI, desktop app, gateway, container, or service does
not automatically receive a new shell value. A service needs its own private
secret injection. GridBase's server-side `.env` does not supply secrets to a
remote client.

Hermes can also resolve secrets from the **active Hermes profile's** private
`.env` or configured secret source. Keep secrets there rather than in
`config.yaml`; the default home is `~/.hermes`, while named profiles or
`HERMES_HOME` can use another location. Codex's example below reads its **process
environment**; do not assume it loads a project `.env` or Hermes's `.env`.[3]

## 3. Hermes Agent

Hermes HTTP MCP entries use `mcp_servers.<name>.url` and a `headers` mapping.
The literal `${GRIDBASE_MCP_TOKEN}` is resolved by Hermes at connection time;
`Bearer $GRIDBASE_MCP_TOKEN` without braces is not this documented substitution
syntax. Missing/empty remote URL/header secret references fail closed in current
Hermes.[3]

The following is the resulting **configuration template**, not a place for the
raw token:

```yaml
mcp_servers:
  gridbase:
    url: "https://gridbase.example/mcp"
    headers:
      Authorization: "Bearer ${GRIDBASE_MCP_TOKEN}"
    protocol: legacy
    skip_preflight: true
    timeout: 60
    connect_timeout: 30
```

Use the CLI to set this entry in your intended active profile, without replacing
its other MCP entries. The single quotes below keep your shell from expanding
the token placeholder before Hermes saves it:

```bash
hermes config set mcp_servers.gridbase '{"url":"https://gridbase.example/mcp","headers":{"Authorization":"Bearer ${GRIDBASE_MCP_TOKEN}"},"protocol":"legacy","skip_preflight":true,"timeout":60,"connect_timeout":30}'
hermes mcp test gridbase
```

The compatibility settings are deliberate:

- `protocol: legacy` selects the `initialize` handshake used by GridBase's 2025
  MCP versions. GridBase is stateless at the HTTP/session layer; that does **not**
  mean it implements the newer `server/discover` protocol selected by Hermes's
  `protocol: stateless` option.[3]
- `skip_preflight: true` skips Hermes's HEAD/GET content-type preflight. GridBase
  accepts MCP **POST** and returns `405` for authenticated GET, rather than
  opening an SSE stream. It does not disable TLS certificate verification or
  bearer authentication. Do not set `transport: sse`.[3]
- The client timeouts are examples, not changes to GridBase's execution limit.
  Do not raise them to work around an authentication or permission error.

Start a new Hermes session, use `/reload-mcp` in an existing supported session,
or restart the relevant gateway after configuration changes. For a rotated
process-environment token, restart from a process that actually has the new
value. Hermes registers names such as `mcp_gridbase_list_connections` and
`mcp_gridbase_execute_query`.[4]

`hermes mcp test gridbase` checks connectivity, initialization and tool discovery;
it is not proof that JDBC execution or externally provisioned read-only grants
work. After it succeeds, ask for `list_connections`, then a harmless metadata
operation or `SELECT 1` on an explicitly selected non-production profile. Do not
use a production write attempt as a read-only permission probe.

## 4. Codex CLI

Codex Streamable HTTP configuration uses **`bearer_token_env_var`**, whose value
is the environment variable **name**, not `${...}` interpolation and not the raw
token. Codex constructs the Authorization bearer header itself.[2][5]

After setting `GRIDBASE_MCP_TOKEN` in the environment, register the server:

```bash
codex mcp add gridbase \
  --url https://gridbase.example/mcp \
  --bearer-token-env-var GRIDBASE_MCP_TOKEN
codex mcp get gridbase --json
```

Equivalent minimal TOML for your Codex configuration:

```toml
[mcp_servers.gridbase]
url = "https://gridbase.example/mcp"
bearer_token_env_var = "GRIDBASE_MCP_TOKEN"
```

The default configuration is `~/.codex/config.toml` (or the active `CODEX_HOME`);
a trusted project's `.codex/config.toml` can also supply MCP entries. Avoid
accidentally creating competing entries in multiple configuration layers. Restart
Codex with the token present, then use `/mcp` to inspect the connected server and
ask it to call `list_connections`.[2]

`codex mcp get ...` reads configuration; **it does not authenticate, discover
tools, or run a query**. GridBase uses account-issued bearer tokens, not an MCP
OAuth server: `codex mcp login gridbase` is not the setup or rotation procedure.
Do not configure both a static Authorization value and this bearer variable.[2]

### Approval before writes

For `full_access`, require approval in the **AI client before SQL is sent**.
Review the connection, complete SQL, and possible effect. There is no GridBase
browser modal protecting a remote call, and MCP annotations do not enforce
human approval on their own.

Current Codex documentation supports the following setting inside the same
`[mcp_servers.gridbase]` table to prompt for every tool, or `"writes"` to prompt
for tools not marked read-only:[2][5]

```toml
default_tools_approval_mode = "prompt"
```

GridBase advertises `execute_query` as potentially destructive for a
`full_access` token even if a particular SQL string happens to be a SELECT.
Check the actual behavior of your installed Codex version and any organization
policy; a parser accepting a key is not proof an approval will appear. For
Hermes, likewise verify the installed client's MCP approval/trust behavior
before granting write-capable access. Do not run a write-capable token unattended
or assume normal terminal-command confirmations cover MCP SQL. If approval
cannot be guaranteed, use a `read_only` token and read-only profile instead.

## 5. Tools and explicit connection selection

| Tool | Required arguments | Purpose |
| --- | --- | --- |
| `list_connections` | None (`{}`) | Approved, currently valid saved profiles and safe metadata, not credentials. |
| `list_databases` | `connectionId` | Supported database/schema discovery. |
| `list_tables` | `connectionId`, `namespace` | Tables in the specified database/schema. |
| `describe_table` | `connectionId`, `namespace`, `table` | Column metadata. |
| `execute_query` | `connectionId`, `sql` | One statement under the effective read-only/full-access policy. |

Use an ID returned by `list_connections`, never a guessed ID or display name.
Every database tool requires `connectionId`; omission, foreign IDs, and stale
grants never fall back to a default connection. Namespace/catalog behavior follows
the existing driver/workbench support; MCP does not add arbitrary Spark/Hive
catalog discovery.

Example tool arguments after obtaining your real approved ID:

```json
{"connectionId":"YOUR_APPROVED_CONNECTION_ID","sql":"SELECT 1"}
```

HTTP `200` does not by itself mean a tool succeeded. Inspect the MCP result's
`isError` and content, as well as truncation and audit metadata.

## 6. Read-only SQL subset and trust boundary

The read-only filter is intentionally smaller than any database's complete SQL
dialect. It parses and validates the whole statement, including nested SQL;
unsupported or unparseable syntax is rejected, not retried with full access.
Use the metadata tools instead of SQL `SHOW` or `DESCRIBE` for read-only discovery.

The implemented common PostgreSQL/MySQL/Spark-Hive subset includes ordinary
SELECT projections, predicates, joins, GROUP BY/HAVING, ORDER BY, LIMIT/OFFSET,
read-only subqueries/CTEs, CASE, and supported UNION/INTERSECT/EXCEPT forms.
Dialect support and actual execution still depend on the database.
For example:

```sql
SELECT id, name FROM customers WHERE id > 10 ORDER BY id LIMIT 20;
```

```sql
WITH totals AS (
  SELECT customer_id, SUM(amount) AS total
  FROM orders
  GROUP BY customer_id
)
SELECT customer_id, total FROM totals WHERE total > 10 LIMIT 20;
```

The current built-in function-name allowlist in `McpSqlPolicy` is:

```text
count sum avg min max abs ceil ceiling floor round sqrt power mod
coalesce nullif lower upper length char_length character_length
concat concat_ws substring substr trim ltrim rtrim replace greatest least
```

Names are case-insensitive but must be unqualified and unquoted. A listed name
does not imply support for every dialect-specific argument form. Casts, window
functions, table functions, custom/qualified functions, optimizer hints and
Spark/Hive scripts are intentionally unsupported in this read-only subset.
The implementation and accepted/rejected examples live in
[`McpSqlPolicy.java`](../java-service/src/com/peentar/thriftquery/McpSqlPolicy.java)
and [`McpSqlPolicyTest.java`](../java-service/src/com/peentar/thriftquery/McpSqlPolicyTest.java);
this is a supported subset, not a promise to accept all SELECT syntax.

Rejected constructs include DDL/DML, writable CTEs, multiple statements,
SELECT INTO/OUTFILE, locking clauses, EXPLAIN (including EXPLAIN ANALYZE of
writes), session/resource/extension commands, and Spark/Hive
TRANSFORM/MAP/REDUCE. An optional final semicolon is allowed, but SQL scripts are
not. Dollar-quoted strings, backslash escapes, and executable/nested block
comments are outside the supported lexical subset. Prefer simple standard SQL;
a server denial is not an invitation to bypass the filter.

**This filter is not an absolute proof that a SELECT is side-effect free.**
Views, functions, custom operators/casts, storage handlers, and object/name
resolution depend on trusted database administration. Even a familiar allowed
function name can resolve differently in an administrator-controlled environment.
Database and storage privileges remain the security boundary.

- **PostgreSQL/MySQL:** GridBase additionally establishes database read-only
  transaction semantics, fails closed if setup fails, and rolls back/closes the
  call's connection. This adds protection; it does not verify grants or make
  privileged credentials safe.
- **Spark Thrift/Hive:** GridBase does not rely on JDBC `setReadOnly(true)` or
  rollback, which the installed Hive driver does not support. Configure the
  actual deployment's Hive authorization, Spark catalog permissions, and storage
  identity/ACLs externally. A catalog restriction alone may not restrict direct
  object-storage access. GridBase cannot prove administrator-controlled UDFs or
  storage handlers harmless, and does not issue a production write probe.

## 7. Expiry, rotation, revocation, and profile changes

- The token list shows its name, safe prefix, scope, selected connections, expiry,
  and revoked state; it never returns the raw bearer value. The server stores a
  one-way SHA-256 lookup digest and token/grant metadata, not a recoverable token.
- Use **Settings / MCP → Revoke** to revoke a token. Authentication is checked on
  every MCP request; expired and revoked tokens are rejected before new database
  work. Revocation cannot undo a completed write or guarantee that an already
  running driver stops.
- Scope and connection grants are immutable. To rotate a token or change its
  permissions, issue a replacement, update the appropriate client secret,
  reconnect and verify, then revoke the old token. For a suspected leak, revoke
  first rather than preserving a rotation overlap.
- **Workbench Disconnect is not token revocation.** MCP uses approved saved
  profiles and opens/closes its own JDBC connections, independently of the
  workbench's transient Connected state. This also works after an app restart
  without a browser Connect step. Browser logout is not a token-rotation action.
- Saving/reconnecting with changed profile settings, including credentials or
  read-only declaration, creates a new non-reusable profile generation and
  invalidates old grants for that profile. Reconfirm externally provisioned
  read-only eligibility after changes and issue a replacement token. Merely
  connecting unchanged settings does not invalidate grants.
- Deleting a profile prevents its use; recreating the same ID does not revive
  old grants. To remove one selected connection while retaining the others,
  replace the token with a smaller selection and revoke the old one.
- Disabling/removing a server in Hermes/Codex or deleting a local environment
  variable only disconnects that client. **It does not revoke the server token.**

Token state is durable in the private application data directory
(`data/mcp.sqlite`). Protect the volume and backups alongside encrypted profiles
and their key. Do not restore an old token-store backup blindly: a restore can
restore previously valid token state, including pre-revocation records.

## 8. Limits, timeouts, and uncertain outcomes

| Limit | MCP boundary |
| --- | --- |
| JSON request body | 64 KiB |
| SQL length | 20,000 characters |
| Query result rows | At most 500, independently of a larger explicit SQL LIMIT; configured/default query limits can be lower. |
| Metadata entries | At most 1,000 per metadata result. |
| Serialized tool response | 1 MiB; oversized data is omitted with an explicit truncation/omission indication rather than implying the query failed. |
| Token count | 20 active tokens per account. |
| Database work | Finite call deadlines, driver-supported connect/socket/query timeouts, and a bounded MCP worker pool. |

The server uses `QUERY_TIMEOUT_MS` (default `30000`, bounded to `1000`–`120000`
ms). Client `timeout`/`tool_timeout_sec` settings do not override this. Connection
establishment and metadata work also consume the server's call deadline.
PostgreSQL/MySQL receive per-call driver connect/socket timeout settings; the
installed Hive 2.3.9 driver has no supported JDBC connect/socket-timeout property,
so its bounded worker can remain occupied until a late call actually returns.
Drivers can ignore cancellation or timeout requests; a bounded client wait is
not proof that server-side SQL has stopped. Late results/connections must still
be cleaned up, and a stuck driver retains worker capacity instead of allowing
unbounded replacement threads.

Inspect truncation flags and narrow the query or metadata request when needed.
A result truncated or omitted for size is not proof the SQL did not execute.
GridBase does not silently retry SQL after an uncertain result. **After a timeout,
network loss, cancellation, or incomplete audit, never automatically repeat a
write.** Check database state and the audit request ID first; there is no
exactly-once execution guarantee.

## 9. Audit and sensitive data

The **Logs** rail opens the Activity view. MCP metadata/query operations carry
`source=mcp`, verified account, non-secret token ID/name, connection, outcome,
duration/counts, and a request ID. Query events include **the submitted SQL text**;
literals/comments containing sensitive data therefore remain in audit storage and
backups. Do not embed credentials or secrets in SQL. Row results are not a safe
place to expose secrets to an AI client either.

A durable pending audit intent is recorded before JDBC; an audit failure at that
stage blocks execution. If final audit persistence fails after SQL executes, the
actual tool result is preserved with **`auditIncomplete: true`**. Tool-result
metadata/content includes `requestId` and `auditIncomplete`; inspect both rather
than assuming a client shows every metadata field. Pending/incomplete audit is
not proof of SQL failure. Owner/admin Activity visibility remains unchanged;
MCP tokens do not grant audit-administration access.

## 10. Deployment and protocol requirements

- **Remote clients must use HTTPS.** Configure `APP_URL` to the exact HTTPS origin
  (no subpath), and have a trusted reverse proxy terminate TLS. The Java listener
  is plaintext HTTP: setting `APP_URL=https://...` does not enable TLS on it.
- Keep the **proxy-to-app hop private**: bind to loopback when co-located, or an
  isolated trusted network when separated; restrict direct listener access.
  Plaintext traffic on that hop includes bearer credentials and database results.
  Do not expose the app port publicly or trust arbitrary `X-Forwarded-*` headers
  as evidence of a secure request. Keep proxy/access/debug logs free of tokens.
- Loopback `http://127.0.0.1:4173/mcp` is allowed for local development. A remote
  client cannot use its own loopback to reach another machine's GridBase.
- Preserve Authorization, MCP headers and JSON responses through the proxy. A
  present `Origin` must match configured `APP_URL`; CLI requests without Origin
  are allowed. Browser cookies alone do not authenticate MCP. Query strings,
  including query-string tokens, are rejected.
- Transport: stateless **Streamable HTTP**, JSON-RPC 2.0 POST with JSON responses;
  supported protocol versions are **2025-03-26**, **2025-06-18**, and
  **2025-11-25**. Use initialize, notifications/initialized, ping, tools/list,
  and tools/call. Subsequent requests use `MCP-Protocol-Version`; omission assumes
  `2025-03-26`. Unsupported initialization versions negotiate `2025-11-25`.
- Send `Content-Type: application/json` and Accept covering both
  `application/json` and `text/event-stream`, even though GridBase returns JSON,
  not an SSE stream. Accepted notifications return `202` with no body.
- No SSE/GET stream, session storage, OAuth discovery, resources, or prompts are
  advertised. Authenticated GET returns `405` with `Allow: POST`. JSON-RPC batches,
  duplicate JSON keys and malformed messages are rejected.

## 11. Troubleshooting and validation scope

| Symptom | Check |
| --- | --- |
| `401` | Token expired/revoked, wrong raw value, extra `Bearer ` prefix, missing client environment, or a proxy stripping Authorization. |
| `403` | A present Origin differs from `APP_URL`; inspect any reverse-proxy denial separately. |
| `400` / version rejection | Correct endpoint, supported protocol, no query string, and the actual installed client's handshake. For Hermes use the documented legacy handshake, not modern `server/discover`. |
| `405` on a browser GET | Expected; opening `/mcp` in a browser is not an MCP connection test. Use the client probe. |
| `406` / `415` | Required Accept / Content-Type headers were lost or incorrect. |
| Empty connections / grant denied | Token selection, account ownership, profile deletion/change, generation invalidation, and current read-only eligibility. Workbench Connect is not the remedy for a stale grant. |
| Unsupported SQL | Simplify to the documented read-only subset; do not broaden permissions just to evade a parser rejection. |
| Database failure | Verify driver, network, dedicated credentials and permissions without printing secrets. |
| Capacity full / timeout | Check database/driver health and retained worker activity; do not automatically retry an uncertain write. |
| Tools missing | Verify connection/discovery and client filters. GridBase does not expose resources or prompts. |

The client configuration syntax was checked against the official documentation
below, the installed Hermes CLI/config interpolation helper, and **Codex CLI
0.169.0**. Isolated temporary `HERMES_HOME` / `CODEX_HOME` directories were used:
Hermes accepted and persisted the literal header template; a dummy non-secret
value interpolated correctly and an unset value failed closed; Codex `mcp add`
and `mcp get --json` preserved `bearer_token_env_var`. Codex 0.169.0 accepted a
`default_tools_approval_mode` override without error but did not echo that key in
`mcp get --json`; no runtime approval behavior was verified. YAML/TOML parsing
is a configuration check, **not** an end-to-end MCP or database compatibility test.

These documentation checks did **not** install into any user's live client
configuration, use a real token/database, prove a write-approval prompt, verify
production database grants, or test every released Hermes/Codex version. Before
production use, verify initialization, discovery, a harmless approved tool call,
expiry/revocation, and the actual client's approval behavior in your deployment.

## Sources

[2] https://learn.chatgpt.com/docs/extend/mcp?surface=cli
[3] https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference
[4] https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
[5] https://developers.openai.com/codex/config-reference
