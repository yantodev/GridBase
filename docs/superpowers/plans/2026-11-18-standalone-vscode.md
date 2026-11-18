# Standalone VS Code Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce tested Linux/Windows x64 .vsix packages that run GridBase locally without GitHub, a separate server, or an installed Java runtime.

**Architecture:** Consume the accepted desktop phase's immutable Java17 engine bundle, Actor/local-auth protocol and EngineClient broker. A local UI extension host owns the engine, secrets and command safety; native tree views and a results Webview expose database operations without a webview-to-localhost trust shortcut.

**Tech Stack:** TypeScript, VS Code Extension API, Node22 build tooling, `@vscode/vsce`, `@vscode/test-electron`, shared CommonJS `packages/local-engine`, packaged Java17/JDBC. Resolve supported dependency versions and minimum `engines.vscode` against the APIs actually used; pin them with a lockfile at implementation.

**Spec:** `docs/superpowers/specs/2026-11-18-standalone-clients-design.md` (approved). Shared implementation prerequisite: `docs/superpowers/plans/2026-11-18-standalone-desktop.md`, Tasks 1–8.

## Global Constraints

- Begin only after desktop/shared-engine acceptance or explicit user-approved resequencing; do not duplicate SQL/auth/storage implementations.
- Windows11 x64 and Ubuntu24.04 LTS x64, VS Code desktop only; platform-specific .vsix. No vscode.dev/web, remote-host execution, ARM/macOS or automatic connection/data synchronization.
- `extensionKind: ["ui"]`: the backend and network access remain on the user's local UI machine even with a remote workspace. State this clearly; do not claim WSL/Remote SSH/Dev Container backend support.
- One local offline Actor per OS user/extension global data directory. No GitHub login and no application password. Extension data are separate from desktop/server data; no automatic import.
- Install may obtain OS prerequisites; post-install launch requires no Internet, JVM installation or first-run executable download. Bundle verified engine/runtime.
- Use SecretStorage, never settings.json/workspaceState/globalState for keys, tokens or database credentials. Webview receives no engine capability or master key. Database password entry/Edit values remain transient, never persisted in webview state.
- Untrusted workspaces do not start an engine or execute database commands. Do not accept binary/JDBC/engine launch paths from workspace configuration.
- Preserve SQL current-selection/caret behavior, UPDATE/DELETE confirmation, JSON details, audit-before-export and MCP scopes/read-only ceilings. No automatic write retry after uncertain failure.
- No commit/push/Marketplace registration/release/CI dispatch without explicit permission. Native Windows testing and signing limitations must be reported, not simulated.

## Review Focus

- Untrusted/remote workspaces must not launch a backend in an unintended host or inject executable paths; test Tasks 1 and 5.
- Rapid editor/connection switching must never send selected SQL to another connection or accept stale results into a different panel; test Tasks 2 and 3.
- Forged Webview messages, arbitrary resources, HTML-bearing result strings and oversize exports must not escape the broker; test Tasks 2 and 3.
- Extension reload/VS Code shutdown/crash must stop the owned child and preserve the original encryption key; test Tasks 1 and 5.
- Packaged .vsix upgrades, SecretStorage loss, missing keyring, spaces/non-ASCII paths and absent Java PATH must not erase profiles or silently downgrade key protection; test Tasks 1, 4 and 5.

---

## File map and interfaces

Create `vscode-extension/{package.json,package-lock.json,tsconfig.json,.vscodeignore,README.md,CHANGELOG.md,src/,media/,test/}`. Reuse `packages/local-engine/index.js`/`protocol.js` and engine bundle manifest from desktop; no code fork. Add `scripts/package-vsix.js` and `.github/workflows/vscode-extension.yml` only in this phase.

- Shared `EngineClient.start({bundleDir,dataDir,tempDir,clientKind:"vscode",credentialKey})` and `request/stop/onExit` contracts are defined in desktop plan Task5. Bootstrap secrets go by stdin, readiness protocol1; limits 64KiB request/16MiB response/20,000 SQL chars.
- `SessionController.start(context:ExtensionContext): Promise<SessionController>` loads a SecretStorage key and EngineClient; `request`, `stop`, `state` expose no capability to commands/Webview. `context.globalStorageUri` contains profile/audit data, stable local manifest and lock; temp dir is a private child. Existing data with missing key is an error, never new-key regeneration.
- `ConnectionTreeProvider` implements `TreeDataProvider<DbNode>`; each node has validated `kind`, `connectionId`, optional `namespace/table/column` and generation/version. Nodes are not arbitrary URLs or command strings.
- Commands: `gridbase.open`, `gridbase.addConnection`, `gridbase.editConnection`, `gridbase.connect`, `gridbase.disconnect`, `gridbase.deleteConnection`, `gridbase.refresh`, `gridbase.runQuery`, `gridbase.showHistory`, `gridbase.showLogs`, `gridbase.settings`, `gridbase.stop`.
- Results controller `execute({connectionId,sql,documentUri,documentVersion}): Promise<void>` freezes intended target before confirmation, then checks it is still valid before send. Result panels carry originating request/connection, not whatever source is selected on completion. Export requests reference original audit request ID.

### Task 1: Trusted local extension lifecycle and storage

**Files:** Create `src/extension.ts`, `src/session.ts`, `src/secret-key.ts`, `test/session.test.ts`, extension manifest/tooling and minimal extension-host harness.

- [ ] Write failing tests: untrusted workspace does not spawn/read saved secrets; explicit trust permits local engine; no workspace-level binary overrides; missing bundled runtime returns actionable error without download; SecretStorage existing key restores encrypted profiles; missing/corrupt key with existing data fails, not resets; engine EOF/dispose stops exactly its child. Include local paths with spaces/non-ASCII and absent PATH Java.
- [ ] Implement package manifest `extensionKind:["ui"]`, Workspace Trust capabilities and commands; activate lazily on user action. Store raw 32-byte key base64 in `context.secrets` under a stable extension-owned key name, never synced settings. Parent key memory not logged. Check actual SecretStorage behavior on both target OSes; no silent Linux key fallback. If unavailable, refuse persistent credential use with an explanation rather than weakening the desktop-approved fallback boundary.
- [ ] Implement SessionController with private global storage and shared EngineClient. Do not inherit workspace .env, JVM flags or current working directory for resource/data resolution. Handle child exit with redacted output and uncertain-operation warning; user explicitly restarts.
- [ ] Run unit tests and actual VS Code extension-host start/stop/dispose tests using isolated user-data/extensions directories. Verify untrusted mode and process cleanup after Extension Development Host reload.
- [ ] Review checkpoint: no commit unless authorized; engine/auth code is shared, not copied.

### Task 2: Connection explorer and editor SQL commands

**Files:** Create `src/connections.ts`, `src/query-command.ts`, `src/history.ts`, `src/logs.ts`, `src/settings.ts`, tests; add manifest view containers/menus/keybindings/icons.

- [ ] Write failing behavior tests: add/save/connect/edit/disconnect/delete target exact connection IDs; lazy schema/table/column loading; stale refresh response ignored; missing source never falls back; editing password not saved in workspace config; filter/history/log commands use local actor. Validate tree node arguments rather than trusting command URI payloads.
- [ ] Implement native tree view and commands through SessionController. Connection settings use controlled input forms; secret fields masked. Secret-bearing connection Edit responses stay host/transient form memory; no raw payload in logs, state serialization or tree tooltip.
- [ ] Write tests showing editor selection/current statement follows existing `WorkbenchCore.executionSql` and `mutationOperations`; execute explicit SQL only on chosen connection. Native modal `showWarningMessage(...,{modal:true})` precedes UPDATE/DELETE including executing CTEs/EXPLAIN ANALYZE; Cancel sends nothing and preserves results/history. Freeze SQL+source before dialog; revalidate source generation after dialog to prevent silent reconnect-target changes.
- [ ] Implement query dispatch and read-only history/log views preserving originating connection and request ID. Pin out-of-order results/connection-switch behavior; log SQL only in application audit, not diagnostic channels. No auto-retry write on timeout/crash.
- [ ] Run real extension-host commands with synthetic JDBC then PostgreSQL/MySQL fixtures; observe actual metadata and query/error states. Document Hive fixture limitation if unavailable, do not claim pass.
- [ ] Review checkpoint: current-selection and confirmation contract reviewed.

### Task 3: Secure results Webview and native exports/settings

**Files:** Create `src/results.ts`, `src/webview-protocol.ts`, `media/results.js`, `media/results.css`, tests/E2E; reuse lossless JSON formatter and query-result view helpers as packaged assets, not hand-maintained copies.

- [ ] Write failing tests for typed validated messages, unknown actions, arbitrary URLs/file paths, forged panel IDs/stale request IDs, >16MiB response/export, HTML-bearing result strings, JS prototype keys and invalid resource URIs. Webview has no network connection to localhost, capability, key, raw shell or generic host fetch.
- [ ] Implement Webview resource URIs using `asWebviewUri`/narrow `localResourceRoots` and strict nonce CSP, theme CSS tokens, keyboard navigation and accessible tables. Use host message broker, not disabled CORS/cookie auth. Render result cell text safely; nested JSON formatting preserves big numbers/key order/escapes exactly as desktop.
- [ ] Implement per-origin result panels with filter/sort/pagination, JSON row details, output/audit warnings, history/log display and explicit MCP enable/token settings. MCP secret one-time reveal is bounded/transient and cleared on close; never webview persisted state. Keep distinct native capability vs MCP bearer boundaries.
- [ ] Native export first audits original result, then uses `showSaveDialog` and `workspace.fs` on the chosen URI; no arbitrary path from message. Test Cancel writes nothing, audit failure blocks file output, CSV escaping/JSON source values unchanged after pretty detail display.
- [ ] Run actual extension-host/Webview E2E on both target OSes for rows, JSON, injected markup, selection commands, cancel/approve writes, export, sidebar refresh and engine crash. Check for leaked secrets in output channel, webview state and packaged assets.
- [ ] Review checkpoint: API/IPC paths and renderer security reviewed.

### Task 4: Platform-specific VSIX packaging and distribution

**Files:** Create `scripts/package-vsix.js`, `test/package-vsix.test.js`, extension license/notices/README/CHANGELOG, `.github/workflows/vscode-extension.yml`; update shared packaging hooks without altering desktop/server artifacts.

- [ ] Write failing package tests for linux-x64/win32-x64 selection, wrong manifest/protocol/hash, missing engine/runtime/native SQLite, unsafe bundled path, included development data/.env/credentials, and install-time dependencies. No fallback to developer-machine Java.
- [ ] Implement packages with pinned `@vscode/vsce` and minimum `engines.vscode` matching APIs actually used; include immutable engine assets, Java17 runtime, drivers and notices. Do not publish an extension claiming web/ARM/remote backend support. Use a clearly marked evaluation publisher ID for sideload builds if no production publisher has been supplied; Marketplace requires the actual user-approved publisher.
- [ ] Add Linux/Windows native build/test workflow (read-only permissions by default), checksums and CI artifacts. Do not dispatch/upload/publish until authorized. Exercise `code --install-extension <artifact.vsix>` against isolated VS Code user-data, not merely unzip archive inspection.
- [ ] Document .vsix installation, offline-local account, data directory/backup, local UI-host networking with remote workspaces, trust requirements, runtime ownership, MCP opt-in and unsupported environments. Marketplace authentication/signing credentials never enter source control or chat.
- [ ] Review checkpoint: genuine sideloaded artifact paths/checksums and native evidence.

### Task 5: Installed extension acceptance and compatibility

**Files:** Add `test/installed-extension.test.ts`, `docs/verification/standalone-vscode.md`; finalize extension version/notes after desktop release version is known.

- [ ] On Ubuntu24.04 and Windows11 x64, sideload actual VSIX with no system Java/Spark, disable external Internet after install, open a trusted workspace, and execute metadata/query/JSON/export/log workflows against fixtures. No GitHub login or first-run executable download occurs.
- [ ] Open remote workspace and confirm backend stays local with clear local-network status. Explicitly reject unsupported browser/remote-host execution; test untrusted folder opening cannot start an engine or run a query. Verify malicious workspace settings cannot alter Java/driver paths or spawn commands.
- [ ] Test multiple windows/data-lock conflict, extension reload/disable/VS Code exit, child crash/EOF and manual restart. Confirm no orphan JVM, no uncertain-write retries, no desktop data collision and no access to server-owned data.
- [ ] Save encrypted profile+audit marker, upgrade VSIX, restart and decrypt correctly. Simulate SecretStorage loss/corruption and require safe failure without replacing existing key. Uninstall preserves data unless the user explicitly requests deletion.
- [ ] Run shared/desktop/server and extension unit/E2E suites and independent final review; list missing native OS/Hive/signing evidence. Publish/install success cannot be inferred from a generated filename.
- [ ] Hand over tested VSIX paths/checksums and verification report. Only then ask for authorized GitHub Release assets or Marketplace publication; verify exact remote artifact after upload. No silent reuse of local credentials or account-data migration.

## Self-review and handoff

All phase2 requirements in the approved spec map to Tasks1–5 and consume phase1 contracts unchanged. Desktop/share-engine acceptance remains prerequisite; both phases preserve web GitHub mode. Review Focus has explicit tests in owning tasks. Execution should use the same user-selected method as desktop unless the user changes it; await plan review/method choice, not implementation in this planning step.
