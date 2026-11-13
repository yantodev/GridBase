# Verification evidence

Implementation: dark DataGrip-inspired Operate workbench, GridBase branding. See DATAGRIP_WORKBENCH_SPEC.md for acceptance criteria.

- Node suites: SQL policy and CSV parsing, metadata identifier quoting and HTTP handler contract, console/editor core, controller integration using a DOM simulation, existing server checks.
- Java suites: SQL policy, JSON, environment configuration, actual JDBC execution via proxy fixtures, metadata escaping/deduplication/independent 10,000-row ceiling, Hive JDBC class loading.
- Synthetic Java HTTP: configured and missing-config cases; private .env inaccessible, health redaction, no credential modal or setup mutation, static core served, invalid metadata identifiers return 422, valid metadata and write SQL reach the driver/configuration boundary (503 without a driver). These fixtures never connect to an actual database.
- Syntax/compilation: npm run check. OpenAPI and Compose parsed with the installed YAML parser. git diff --check.
- A local mutation of selected-statement logic in an isolated VM was detected by the selection assertion; shipped source was unchanged by the experiment.

## Visual evidence limitation

CUA inventory was rechecked: no apps or browsers; browser access host unavailable. No desktop/mobile screenshots or visual interaction checks are claimed. No existing screenshot fixtures were found.

The independent Impeccable finish reviewer returned **recapture**, requiring `.impeccable/review/desktop.png` and `mobile.png`. The visual gate remains open. A separate source audit does not constitute visual approval.

The initial detector flagged tiny secondary text and flat type hierarchy. Hook triage raised all 10–11px secondary text to at least 12px and result-state headings from 14px to 16px. The compact IDE keeps 13px UI/code text. Static checks cannot establish rendered contrast, geometry, or viewport quality.

No write queries were run against the user's actual Spark database. SQL mutations remain subject to Spark/table format support and the configured account's permissions.

## Source review corrections

The separate code reviewer identified and verified three editor corrections: Escape now moves focus from the SQL editor to Format; programmatic edits reject changes beyond 20,000 characters; column completion retains aliases while table completion replaces the qualified table token. Regression tests cover these flows. A fourth metadata correction preserves legal `#id` column names while excluding actual DESCRIBE marker/header rows, with Java and Node fixture coverage.


## Query limits and GridBase rename

The application is now named GridBase in the browser title/header, API title, README/product/design documents, startup messages, package metadata, and local image tag. Browser storage keys remain compatible with existing drafts/history.

Query collection no longer imposes a ten-row cap on SQL with an explicit outer LIMIT. Missing LIMIT defaults to 50 returned rows; outer LIMIT NULL is normalized to LIMIT 50. DEFAULT_QUERY_LIMIT replaces the previous MAX_QUERY_ROWS setting. Generated table previews use LIMIT 50. Result pagination remains ten rows.

Regression evidence includes Java JDBC fixture queries with LIMIT 20, 75, 0, missing LIMIT, and LIMIT NULL; SQL limit masking/subquery/CTE checks in Java and Node; Node handler contract tests; and controller checks for two pages of 20 rows and five pages of 50 rows. A synthetic JDBC driver was also used through the actual Java HTTP endpoint: LIMIT 20/75/0 and missing/NULL limit returned 20/75/0/50/50 rows respectively, with the GridBase HTML title served. No actual database was accessed by these tests.

The final independent source review confirmed the quoted-identifier LIMIT correction. Quoted table and quoted ORDER BY cases preserve LIMIT 75, and quoted-table LIMIT NULL becomes LIMIT 50. Final automated and synthetic HTTP checks passed.


## Multiple connections in the left Database panel

The Add connection action and connection settings now live in the left Database panel. Data sources have independent metadata trees and loading/error states. Each SQL console persists its connection ID and shows a connection selector; same-named tables in different sources open separate consoles. Changing explorer selection does not change existing console routing. Missing or explicitly unbound console connections remain disabled across refresh/reload.

The Java backend registers immutable per-connection JDBC services with stable IDs. Query and metadata requests capture the selected service. Disconnect removes only that source, unknown IDs return 404 without fallback, and failed reconnects preserve the previous profile. Passwords and JDBC URLs are excluded from saved browser profiles; safe API targets omit JDBC auth parameters and user info.

Verification: the full Node and Java suites pass. Controller fixtures cover two dialects, equal source/table names, originating query/history/draft association, disconnected and explicitly unbound consoles, reconnect locking, per-connection metadata and out-of-order refreshes, and ten-row result pagination. Real Java HTTP route tests use synthetic JDBC for two connection types, reads/writes, metadata, default limits, reconnect failures, disconnect isolation and unknown-ID rejection. These do not establish live multi-database access.

Fresh CUA inventory still reports browser access host unavailable. The independent finish reviewer returned **recapture** because desktop/mobile captures remain unavailable. No rendered verification or visual approval is claimed.


## Server settings only; no automatic Spark source

The .env and .env.example now contain only PORT=4173, QUERY_TIMEOUT_MS=30000 and DEFAULT_QUERY_LIMIT=50. Compose no longer forwards database credentials or database type. Java AppConfig loads server settings only, and ConnectionRegistry starts empty even if obsolete Spark credentials remain in the file or process environment. Users connect all data sources from the left Database panel. Browser profiles remain available as disconnected profiles after a server restart. Regression checks cover old file/process settings and explicit runtime connections.

## SQLite connection-settings extension: design documentation check

Compared `public/index.html`, the connection-manager paths in `public/app.js`, and `public/styles.css` with `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json`, and the direction contract in `.impeccable/surfaces/public-index-html.md`, following `reference/document.md` and the ordinary-extension rule in `reference/new-work.md`. The incumbent design files are preserved. The stylesheet is unchanged; this extension adds no visual tokens or replacement world.

The connection dialog retains graphite chrome, editor-colored labeled fields, the masked password input, outline SVG controls, live form-status text, and the existing saved-source list. The new connection Save uses the recorded secondary tool-button treatment while Connect remains the primary action; rename Save still uses the primary family described by the incumbent system. Loading locks the existing form and action controls and ignores stale profile responses. The existing scrollable dialog, wrapping action row, two-column form, and single-column breakpoint at 620px remain source-evidenced.

The existing dialog border/shadow and `rgb(101,107,120)` detector advisories are not promoted to new tokens or repaired in this ordinary extension. Soft floating-dialog shadows already belong to the recorded Working Plane Rule. Finish disposition remains **recapture**: desktop and mobile captures are missing, and the supplied CUA inventory reports no apps or browsers because the browser host is unavailable. This documentation check does not establish rendered fit, legibility, or visual approval.

## SQLite persistence: implementation and runtime evidence

The Java service now persists complete profiles in `data/gridbase.sqlite`, encrypted with AES-GCM and a generated `credentials.key` in the same directory. Compose mounts a named volume at `/app/data`; the runtime directory is mode 0700 and database/key are 0600 under UID/GID 10001. Credentials are returned only by explicit Edit detail requests with `Cache-Control: no-store`; list/health responses and browser localStorage exclude passwords and JDBC parameters. Save does not open a database connection, Disconnect retains the profile, Delete removes it, and restart restores profiles disconnected without an implicit default. Old browser-only profiles require one-time credential entry.

Verification: `npm test`, `npm run check`, `git diff --check`, and OpenAPI validation pass. Actual SQLite tests cover encrypted bytes, exact credential/form-field round trips, update/delete, missing encryption key, and no remote opens during restore/offline save. Real Java HTTP tests with synthetic JDBC cover persistence across server restart, failed storage writes preserving the previous settings and active service, no-store responses, and Edit/Delete for IDs matching action-route names. JSON tests cover profile names matching field names, which previously could change the parsed password. Controller fixtures cover credential restoration, generated PostgreSQL JDBC URL updates, late response guards, offline profiles, and legacy re-entry. Temporarily inverting the connected-state condition caused the controller suite to fail, then the source was restored.

The rebuilt Docker application was exercised with temporary offline profiles: Save/Edit/update, exact password and secret-bearing JDBC URL readback after force-recreate, disconnected startup with no default, and named-volume persistence passed. Only the synthetic verification profiles were deleted afterward. No real database authentication or remote SQL mutations were tested. The installed `postman` executable resolves to the desktop app and cannot run headlessly; API evidence comes from the repository's real HTTP tests and Docker readback.
