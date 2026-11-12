# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

GridBase is a local browser workspace for querying and changing Spark Thrift data through Java Hive JDBC. The existing Node/Beeline service remains a legacy backend.

## Operating Context

The connection uses THRIFT_JDBC_URL, THRIFT_USERNAME, and THRIFT_PASSWORD from the server's .env or process environment. Credentials stay on the server. Database objects use the s3tables catalog.

## Capabilities and Constraints

- Read and write SQL, one executed statement per API request.
- Explicit SQL LIMIT controls result size. Missing LIMIT or LIMIT NULL defaults to 50 rows. Result pagination: 10 rows per page.
- Recent query history stays in browser storage; query results stay in memory.
- Preserve connection configuration, row detail, history, and write-result reporting.
- Confirmed scope: database explorer, SQL tabs, editor, results; inline table editing and transaction management are outside this iteration.

## Brand Commitments

The user requested an experience similar to JetBrains DataGrip and explicitly chose its dark New UI direction. Keep the product name GridBase.

## Evidence on Hand

- Existing implementation in public/, Java JDBC service, Node legacy service, and openapi.yaml.
- Official JetBrains Services tool-window documentation: https://www.jetbrains.com/help/datagrip/services-tool-window.html.
- User confirmed the core workflow and dark direction in this conversation.

## Product Principles

- Keep SQL, database objects, and results within one working screen.
- Make every visible control perform its advertised action.
- Keep drafts and results associated with their originating console.
- Derive object names and connection status from the actual server, without demonstration data in the shipped UI.
