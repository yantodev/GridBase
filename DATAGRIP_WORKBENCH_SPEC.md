# DataGrip-style workbench

The user confirmed a dark DataGrip New UI direction and the core explorer, console tabs, SQL editor, and results workflow. This is an original implementation of those observable interaction patterns in the existing application.

## Capability map

| Module | Responsibility | Depends on |
| --- | --- | --- |
| metadata | List namespaces, tables, and typed columns without the query result cap | Existing JDBC / Beeline connection |
| console | Persistent SQL drafts, tab lifecycle, selected/current-statement execution | Existing query API |
| editor | SQL highlighting, indentation, formatting, loaded-object completion | Console and metadata |
| results | Per-console grid, sorting, filtering, pagination, record detail, CSV/JSON export, output | Console |

Build order: metadata and console model, editor shell, explorer and execution, results, verification.

## Acceptance criteria

- Expand a namespace, list its tables, inspect columns, and open a table using a fully qualified SELECT with LIMIT 50.
- Create, switch, rename, and close consoles. SQL drafts survive reload. Switching during execution cannot assign results to another console.
- Execute the selected SQL or the statement at the caret with Ctrl/Cmd+Enter. Preserve literals and comments during editing and formatting.
- Display actual query results with ten-row pagination, sortable columns, a local result filter, NULL values, row detail, and CSV/JSON downloads.
- Keep successful write statements and zero/unknown affected-row counts distinguishable from result sets.
- Provide working Results and Output tabs, query history, refresh, sidebar collapse, and resizable panes with keyboard alternatives.
- Retain .env configuration, SQL write support, and the default fifty-row result limit.
- Empty, loading, offline, missing configuration, query error, metadata error, and filtered-empty states are usable.
- No inline table editing, transaction controls, fake connections, or decorative nonfunctional menus.

## API contract

- Existing GET /api/databases and POST /api/query stay compatible.
- GET /api/tables?namespace=... returns {tables: [string]}.
- GET /api/columns?namespace=...&table=... returns {columns: [{name, type, comment}]}.
- Metadata identifiers must be nonempty and at most 256 characters; identifier quoting escapes backticks. Invalid arguments return 422.
- Metadata has an independent 10,000-row ceiling. Explicit outer SQL LIMIT is honored; missing LIMIT or LIMIT NULL defaults to 50 rows (DEFAULT_QUERY_LIMIT). Result pagination remains 10 rows.

## Validation

Run pure console/editor tests, metadata and JDBC tests, existing suites, syntax/build checks, API checks with synthetic credentials, and static accessibility/design checks. The connected browser host is unavailable in this session; record this limitation rather than claiming rendered-browser verification.
