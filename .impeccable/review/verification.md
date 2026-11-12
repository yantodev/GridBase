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
