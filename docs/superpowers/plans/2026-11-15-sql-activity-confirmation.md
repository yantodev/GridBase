# SQL Activity and Confirmation Implementation Plan

> Native execution in this session using TDD; do not commit or restart deployments.

Goal: Persist submitted SQL for query activity and confirm UPDATE/DELETE execution.
Architecture: Extend existing audit lifecycle and SQLite schema; reuse the browser tokenizer and native confirmation before changing query state.
Tech stack: Existing Java/JDBC/SQLite and browser JavaScript; no new dependencies.
Spec: docs/superpowers/specs/2026-11-15-sql-activity-confirmation-design.md

## Constraints and review focus

- Keep owner/admin authorization, durable pre-JDBC audit, and private audit permissions.
- Migrate version 1 to 2 preserving rows; reject future versions and leave old SQL null.
- Store submitted SQL only for query.execute; do not copy SQL into export/auth/connection events.
- Cancellation must not send a request, clear results, or change history.
- Ignore SQL keywords in literals/comments and read-only SELECT FOR UPDATE or EXPLAIN; cover mutating CTEs and selected execution.
- Do not alter dependencies, version, credentials, or live data.

## Task 1: SQL activity

Files: AuditStore.java, ActivityAudit.java, AuditStoreTest.java, ActivityHttpTest.java, public/activity.js, test/workbench-controller.test.js.

- [x] Add failing HTTP persistence/isolation/restart tests and SQLite version-1 migration test; observe missing sqlText assertions.
- [x] Add Event.sqlText and schema-2 column, transactionally migrate old tables, bind/read/serialize query text, annotate before JDBC.
- [x] Render SQL through textContent for query.execute details, with a historical-unavailable fallback; verify injection-safe text and non-query exclusion.
- [x] Run focused Java and controller tests until green.

## Task 2: Confirmation

Files: public/workbench-core.js, public/app.js, test/workbench-core.test.js, test/workbench-controller.test.js.

- [x] Add failing controller cases for cancel/confirm, selected/current SQL, comments/literals, CTEs, read-only SQL and keyboard shortcut.
- [x] Add C.mutationOperations(sql) returning unique UPDATE/DELETE operations from statement commands and CTE bodies, then window.confirm before state reset or HTTP.
- [x] Run focused core/controller tests until green.

## Task 3: Documentation and final verification

Files: README.md, openapi.yaml.

- [x] Document nullable sqlText, migration and SQL-literal privacy implications; document workbench confirmation.
- [x] Run npm run test, npm run check, YAML validation and git diff --check.
- [x] Review the final diff for missing lifecycle bindings, unsafe rendering and unrelated changes.

## Final review verification

- Fixed dollar-quoted literal handling, recursive CTE SEARCH/CYCLE decorations, and EXPLAIN ANALYSE detection after observing seven failing regression tests; all seven now pass.
- Added exact-request SQL persistence assertions for rejected, failed, and incomplete/pending query audit events.
- Re-ran all 39 core/controller tests, full npm run test, npm run check, and git diff --check successfully after fixes. OpenAPI YAML parsed with duplicate-key rejection.
- Scope decisions retained: SQL literals are intentionally persisted with owner/admin access; confirmation is a UI safeguard, not an API authorization or transaction protocol; other mutation command types, functions/triggers, native-dialog styling, deployment, versioning, and backup operations remain outside this change. No review findings deferred.
