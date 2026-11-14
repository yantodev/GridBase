# Audit Aktivitas Pengguna Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Persist trustworthy per-account activity and provide an admin-capable Activity view.

**Architecture:** Separate SQLite audit store with durable pending intents and safe outcome metadata. Per-request HTTP wrapper instruments Java operations; auth assigns verified actors. Activity APIs enforce session IDs and administrator IDs. Browser exports reference a successful owned query, and a separate Activity module renders filtered results.

**Tech Stack:** Java HTTP/JDBC, existing SQLite driver, browser JavaScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-14-user-activity-audit-design.md` (user-approved).

## Global Constraints

- Audit database: `data/audit.sqlite`, private permissions, persisted in existing data volume.
- Admins: `AUDIT_ADMIN_IDS`, numeric immutable GitHub IDs; local selection `49233072`.
- No SQL text, row results, credentials, OAuth state/code, cookies, tokens, raw request bodies, or raw database errors in audit storage/API.
- Users see only their own audit; explicit all-account scope/filter/users list requires admin. Admin audit never bypasses connection ownership.
- Durable pending intent precedes database operations; failure prevents JDBC; completion failure preserves the original operation response with an audit-warning header and pending record.
- Logout revokes even when audit storage fails. No automatic deletion; no edit/delete audit API.
- No version bump, commit, push, or new release unless requested.

## Review Focus

- Alternate endpoint spellings and unsupported HTTP methods must not execute unaudited JDBC.
- Auth callbacks may change actor after request start; invalid/unverified identity must remain anonymous.
- Stale browser responses and capability spoofing must not reveal cross-account logs.
- Storage unavailable before versus after a write needs different behavior; successful SQL must not be misreported as unexecuted.
- Export correlation must survive disconnect/deletion but reject other users and fabricated query references.

### Task 1: Audit persistence and configuration

**Files:** create `java-service/src/com/peentar/thriftquery/AuditStore.java`, `AuditStoreTest.java`; modify `AppConfig.java`, `AppConfigTest.java`, `test-java.sh`.

**Interfaces:**
- `AppConfig.auditAdminIds`: immutable `Set<String>` parsed from `AUDIT_ADMIN_IDS`.
- `AuditStore(Path dataDir)` initializes/validates independent audit schema version 1.
- `AuditStore.Event`: request ID, verified actor ID/login, action, source, connection ID, SQL operation/fingerprint, row counts, start/finish timestamps, HTTP status, outcome, safe code, duration.
- `begin(Event)`, `annotate(Event)`, `finish(Event)` persist lifecycle without holding locks around JDBC; `list(String ownerId, boolean admin, Map<String,String> filters)` returns bounded cursor page; `users()` lists safe actor snapshots; `ownedQuery(String requestId, String ownerId)` validates successful query reference.

- [x] Add an HTTP-level missing-feature test (Task 2 fixture) using existing constructors and real SQLite, expecting audit history after login/query; run and observe missing `/api/activity` failure before implementation.
- [x] Write `AuditStoreTest` for pending/finished records, isolated own scope, explicit admin scope, anonymous login failure, filters, cursor boundaries, restart, parallel writes, and unsupported future schema. Test secrets absent from disk/API, IDs independent of username, and private file permissions.
- [x] Implement persistence and validated admin-ID configuration with prepared statements and exact action/outcome allowlists. Use monotonically increasing internal IDs with cursor as a decimal string; default page 50, maximum 100. Require UTC ISO instants for date filters and reject invalid/unknown filters.
- [x] Run `SPARK_HOME=/home/coder/.local/opt/pyspark-3.5.6/deps bash test-java.sh` (temporary fixture adaptation permitted while Task 2 red test remains outside runner). Expected: all existing programs and new store tests pass.

### Task 2: Trusted instrumentation, APIs, auth and exports

**Files:** create `ActivityAudit.java`, `ActivityApi.java`, `ActivityHttpTest.java`; modify `ThriftQueryServer.java`, `GitHubAuth.java`, related HTTP fixtures, `test-java.sh`.

**Interfaces:**
- `ActivityAudit` owns `AuditStore`, admin policy, and a per-exchange context/wrapper. Helpers bind verified actor and safe connection/query/count metadata; wrapper adds server-generated `X-Request-ID` and reports `X-GridBase-Audit-Warning: incomplete` only on completion persistence failure.
- `GET /api/activity`: `{events:[...],nextCursor:string|null,isAdmin:boolean}`. Filters `scope=mine|all`, `userId`, `from`, `to`, `action`, `outcome`, `connectionId`, `cursor`, `limit`; defaults mine.
- `GET /api/activity/users`: admin-only actor ID/login choices.
- `POST /api/activity/exports`: JSON `{queryRequestId,format:csv|json,rowCount}`; verifies owned successful query and bounded count, records browser-sourced request, returns `{ok:true,requestId}`.
- Session API adds `capabilities.auditAdmin`; query response adds `requestId` for export correlation, with no other contract break.

- [x] Expand initial red HTTP test to cover owner/admin/other account, login/logout/failure, all connection operations, metadata, query counts, unknown/foreign IDs, invalid filters/cursors, tampered owner/capabilities, rename/reuse, and restart.
- [x] Integrate wrapper and exact endpoint dispatch. Avoid shared HttpContext attributes. Begin intent before any JDBC/store operation; bind callback actor only after identity validation. Record safe result codes, never exception content.
- [x] Implement activity access independent of connection registry. Honor existing account header/CSRF checks. Reject all-scope and actor filters by non-admin with 403.
- [x] Add export reference validation; retain query linkage after profile deletion and reject references owned by other users, nonexistent IDs, failed queries, and counts greater than returned rows.
- [x] Inject actual SQLite failure before begin and SQLite trigger failure on finish in tests. Assert zero JDBC opens on begin failure, query success retained on completion failure with pending record/header, and logout still invalidates session.
- [x] Exercise path suffixes, parallel users, anonymous failures, and poll/static exclusions. Run full Java suite. Expected: all programs pass, no secrets persisted.

### Task 3: Activity UI and browser export/warnings

**Files:** create `public/activity.js`; modify `public/index.html`, `public/styles.css`, `public/app.js`, `public/session.js`, `test/workbench-controller.test.js`, `test/session.test.js`.

**Interfaces:**
- `window.GridBaseActivity.mount({api,user,capabilities})` returns a panel controller with `show()`, `exportRequested(queryRequestId,format,rowCount)` and safe UI state; load module before session-driven app bootstrap.
- `GridBaseSession` includes immutable server-returned `capabilities.auditAdmin` alongside existing verified user.
- Activity rail tool offers filters in sidebar and a full-width results table in the main area; switching back preserves SQL consoles. No automatic polling.

- [x] Write frontend regressions for loading own activity, admin filters/pagination, data rendered via text nodes, stale responses ignored after filters change, preserved SQL state, export request bound to originating query, failed audit blocking export, and persistent incomplete-audit warning. Observe RED before changing product scripts.
- [x] Add activity module and responsive accessible controls, safe text rendering, next-page cursor, date/action/outcome/connection/user filters, error/empty/loading states, and request details. Fetch only after opening Activity.
- [x] Thread server capabilities through session bootstrap; UI cannot grant backend access. Export records successful owned query reference before initiating local download and records only format/count. Network/audit failure gives a clear message without downloading an unaudited file.
- [x] Surface incomplete-audit warning without implying a completed SQL statement did not run. Preserve pending/unknown outcomes in Activity.
- [x] Run Node/session/controller suites. Expected: existing behavior and new activity tests pass.

### Task 4: Documentation, review, local verification

**Files:** modify README, OpenAPI, `.env.example`, Compose, Node legacy server/tests as necessary.

- [x] Explain audit fields/capabilities, actor trust, export limitations, persistent backup/archiving, no automatic expiry, unavailable-storage behavior, and Java-only support. Add blank `AUDIT_ADMIN_IDS` example/Compose wiring; Node legacy returns explicit 501 for activity APIs.
- [x] Validate YAML with duplicate-key rejection; run full `npm test` and `npm run check` using the stated Spark path. Expected: all tests and compilation pass.
- [x] Request one fresh final review of the complete working-tree diff against approved design; fix significant findings with RED→GREEN and rerun affected/full verification.
- [x] Configure private local `.env` with `AUDIT_ADMIN_IDS=49233072`. Restart only GridBase through Supervisor once verified, preserve profile DB/key and backups, verify health/auth/API protections and private audit file. Do not fabricate a successful GitHub login in production.
- [x] Report feature location, persistent store, admin selection, verification, and any remaining limitations. Leave commits/publication to a later explicit request.
