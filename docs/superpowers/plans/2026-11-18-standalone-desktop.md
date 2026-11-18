# Standalone Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver tested GridBase .exe and .deb installers with an offline local account, bundled Java/JDBC, private storage, and no required GridBase server.

**Architecture:** Keep the Java/JDBC engine and web/server authentication intact; add a separately selected local entry point with a native-host capability and namespaced local actor. Electron supervises the packaged engine and brokers the existing workbench through a narrow preload interface. The engine distribution and native-host broker are reusable by the later VS Code extension.

**Tech Stack:** Java 17, Node 22 tooling, Electron and Electron Forge (Squirrel.Windows/.exe and deb makers), existing HTML/CSS/JavaScript, SQLite/JDBC, pinned platform Java runtimes. Resolve supported dependency versions from official registries at implementation time and commit exact lockfiles only when authorized.

**Spec:** `docs/superpowers/specs/2026-11-18-standalone-clients-design.md` (approved).

## Global Constraints

- Initial targets: Windows 11 x64 and Ubuntu 24.04 LTS x64. Do not advertise other platforms as tested.
- Installation may fetch declared OS prerequisites; installed-app startup and ordinary operation require neither Internet nor GitHub. Bundle Java 17 and JDBC; never download executable code on first launch.
- One offline local profile per OS user/application-data directory, no application password. Same-OS-user malware is outside the isolation claim; never describe this as a password-protected vault.
- Desktop and extension have separate data directories. No automatic migration, import, owner rewriting, or shared live SQLite data from existing server installations.
- Preserve GitHub isolation, encrypted-profile AAD, existing APIs, audit outcome behavior, SQL confirmations, JSON detail display, and all MCP policy/grant constraints in server mode.
- Preserve the uncommitted build-isolation 1.3.2 fix. Do not reset/stash it away or alter the running service. No commit, push, release, CI dispatch, signing credential change or restart without explicit authorization. Commit steps below are review checkpoints, not permission to commit.
- Native-host capability is at least 256 random bits, per launch, stdin/private IPC only, never arguments/URLs/env/persistent storage/renderer/logs. Host targets the verified spawned child only.
- Local engine binds 127.0.0.1 on an ephemeral port, ignores arbitrary workspace .env settings, and authenticates every local business route. No generic renderer fetch/shell/filesystem API.
- Electron: contextIsolation=true, sandbox=true, nodeIntegration=false, restrictive CSP, validated IPC sender. No navigation to remote application code.
- Use OS-protected storage and verify Windows ACL/Linux modes; do not weaken MCP storage checks to make Windows pass. Linux plaintext-key fallback requires explicit consent when secure keyring is unavailable.
- Work is unfinished until artifacts are exercised. Cross-building a Windows artifact on Linux is not Windows install/run verification. Missing signing/Windows11 testing is reported, not fabricated.

## Review Focus

- A forged local actor/capability must never access server GitHub profiles or authenticate as MCP; pin in Tasks 1 and 3.
- Packaged paths containing spaces/non-ASCII, absent PATH Java, and a hostile workspace .env must not change engine selection/data location; pin in Tasks 2 and 5.
- Shared filesystems/reparse points, Linux missing keyring, and second-process ownership must fail closed or require the specified fallback consent; pin in Tasks 2 and 5.
- Engine crash, timeout after a write, port collision and app quit must not cause duplicate writes, attach to foreign processes, or leave an owned Java child running; pin in Tasks 3, 5 and 8.
- Updated installers/uninstall must preserve the user's encrypted profiles/key/audit, and both install-time dependency resolution and post-install offline launch need native-OS proof; pin in Tasks 7 and 8.

---

## File map and shared contracts

New Java files live alongside existing classes under `java-service/src/com/peentar/thriftquery/`: `Actor.java`, `RequestAuth.java`, `PrivateFiles.java`, `CredentialKey.java`, `LocalWorkspace.java`, `LocalAuth.java`, `LocalEngineMain.java`, `LocalMcpControl.java` and their focused tests. Existing `AppConfig`, auth/router, stores/audit/MCP call sites and tests change only at these boundaries.

New Node packages: `packages/local-engine/` (CommonJS native-host supervisor/broker contracts, reused by VS Code), `desktop/` (Electron shell/Forge packaging). Root test/check scripts invoke their tests; do not mix Electron dependencies into legacy server runtime. `scripts/package-engine.js` builds engine assets, `scripts/engine-dependencies.json` pins downloads, `test/package-engine.test.js` tests the packager. `docs/DESKTOP.md` documents install/security/upgrade.

- `Actor.github(id, login)` keeps numeric GitHub IDs unchanged. `Actor.local(uuid, displayName)` uses owner key `local:<canonical-lowercase-UUID>`. `Actor.ownerKey()` and `Actor.provider()` are the trusted ownership boundary; constructors validate inputs. New local identity is created once in the private local data directory. Never use a fake numeric GitHub user.
- `RequestAuth.actor(HttpExchange): Actor|null`; `handle(HttpExchange, Set<String> auditAdmins): boolean`. Existing `GitHubAuth.User` may remain an OAuth DTO with `toActor()`. Existing GitHub-oriented constructors/tests get narrow adapters, not changed expected ownership.
- `EngineClient.start({bundleDir,dataDir,tempDir,clientKind,credentialKey}): Promise<EngineClient>`; instance `request({method,path,body}): Promise<{status,headers,body}>`, `stop(): Promise<void>`, `onExit(listener)`. `clientKind` is `desktop` or `vscode`. No arbitrary target URL/header parameter. `credentialKey` is a 32-byte Buffer from a host key provider.
- Local bootstrap is one strict UTF-8 JSON line <=8 KiB on child stdin: `{protocol:1,capability:<base64url-32-bytes>,credentialKey:<base64url-32-bytes>,clientKind}`. Paths arrive as explicit validated launch arguments; no secrets there. Keep stdin open after bootstrap; EOF closes the local engine so a parent crash does not orphan it.
- Readiness is one stdout JSON line `{event:"ready",protocol:1,version,pid,port}` after bind/auth/stores/lock succeed. Other diagnostics go to redacted stderr. Host startup deadline 30s; malformed/mismatched readiness kills only its child. Native request body limit 64 KiB; response/renderer IPC limit 16 MiB, reject oversized payloads with a clear local error, do not silently truncate result cells. SQL length remains 20,000 chars.
- Local auth header is `Authorization: GridBase-Local <capability>`; no cookie fallback. `/api/auth/session` returns `{authenticated:true,mode:"local",user:{id:<ownerKey>,login:<displayName>,provider:"local"},capabilities:{auditAdmin:false,mcpEnabled:<boolean>}}` only to the host. Server response remains compatible and adds provider=github without changing numeric id.
- Native frontend bridge only exposes `request`, `saveExport`, `close`, `onEngineState`; payload validators/routes are shared in `packages/local-engine/protocol.js`. Startup UI cannot pass capabilities or arbitrary executable/endpoint paths.

### Task 1: Separate actor identity from GitHub transport

**Files:** Create `Actor.java`, `RequestAuth.java`, `ActorTest.java`; modify `GitHubAuth.java`, `ConnectionWorkspaces.java`, `ConnectionStore.java`, `ActivityAudit.java`, `ActivityApi.java`, `AuditStore.java`, `McpTokenStore.java`, `McpAudit.java`, `McpServer.java`, `McpApi.java`, `ThriftQueryServer.java`, and affected Java tests/`test-java.sh`.

**Interfaces:** Produces validated `Actor`/`RequestAuth` above. GitHub IDs and old ciphertext AAD stay byte-for-byte unchanged; local owner keys use the explicit prefix. Token/audit actors use the shared type. Existing public constructors taking a GitHub DTO may delegate to Actor constructors to keep tests and compatibility.

- [ ] Write failing tests: `ActorTest` accepts GitHub `1001`, rejects numeric local identities and malformed provider keys, and distinguishes `local:11111111-2222-4333-8444-555555555555` from `1001`. Add store/audit tests showing one local owner cannot read another owner or old GitHub-owned data, and existing GitHub profile ciphertext still decrypts without migration.
- [ ] Run focused compile/tests; observe failures caused by missing Actor support, not by altered fixtures.
- [ ] Implement `record Actor(String provider,String id,String login)` with `ownerKey()`/static factories and the RequestAuth adapter. Replace internal GitHub-only validation at store/audit/MCP boundaries; leave `AuthConfig` allowlist/legacy migration targets GitHub-only. Keep server admin IDs GitHub-only. Audit adds source `desktop`/`vscode` for local requests/exports while server/browser/mcp rules stay unchanged. Persisted old records remain readable; do not rewrite numeric owners.
- [ ] Run all existing ownership/auth/store/audit/MCP suites plus new Actor tests; require server unauthenticated requests remain denied, supplied local owner headers cannot choose owners, and MCP tokens resolve their own stored actor.
- [ ] Review checkpoint: inspect identity/AAD diff and record test evidence. No commit unless authorized.

### Task 2: Private local workspace, paths, key injection and locks

**Files:** Create `PrivateFiles.java`, `CredentialKey.java`, `LocalWorkspace.java`, `PrivateFilesTest.java`, `LocalWorkspaceTest.java`; modify `AppConfig.java`, `ConnectionStore.java`, `AuditStore.java`, `McpTokenStore.java`, `AppConfigTest.java`; add tests to Java runner.

**Interfaces:** `PrivateFiles.createDirectory(Path)`, `createFile(Path)`, `verify(Path)` enforce native permissions; `CredentialKey` supplies validated 32-byte AES key without `toString()` exposure. `LocalWorkspace.open(Path dataDir, CredentialKey key): LocalWorkspace` owns a lifetime `FileChannel` lock, stable Actor and local-only manifest; close releases lock. `AppConfig.local(Path resourceRoot,Path dataDir,Path tempDir,String clientKind)` sets local mode, 127.0.0.1/port0, fixed limits and no file/env OAuth loading. `AppConfig.load(...)` remains server mode.

- [ ] Write failing tests for POSIX 0700/0600 and Windows owner-restricted DACLs, unsafe inherited broad write/read grants, symlink/reparse targets, second live process on the same directory, restart recovering the same local Actor, tampered local manifest, and refusing a directory containing a server `gridbase.sqlite` without the local manifest. Include non-ASCII/space paths and bogus neighboring `.env`/PORT/APP_URL settings ignored by `AppConfig.local`.
- [ ] Run tests on available OS; Windows-only tests must be actually run on Windows before claiming that platform done.
- [ ] Implement private file helpers for all stores including key/WAL parent protection. Verify actual access rules; do not rely on swallowed UnsupportedOperationException or exact ACL ordering. Local stores take CredentialKey instead of reading a nearby server `credentials.key`; server mode keeps the old format/key loading and migration behavior. Existing valid local manifest + missing/corrupt key is an error, never regenerate it over existing encrypted data.
- [ ] Verify local data survives reopen; wrong key cannot decrypt; failure paths release only acquired locks. Check server store regressions and local permission failures are actionable/redacted. Never test migrations on live data.
- [ ] Review checkpoint: native permission evidence and lock lifecycle verified; no commit unless authorized.

### Task 3: Explicit capability-authenticated local engine entry point

**Files:** Create `LocalAuth.java`, `LocalEngineMain.java`, `LocalAuthTest.java`, `LocalEngineHttpTest.java`; modify `ThriftQueryServer.java` to accept RequestAuth/AppConfig lifecycle hooks without changing default entry point.

**Interfaces:** Implements bootstrap/readiness contracts. `LocalEngineMain` is the only packaged-local entry point. Local health/readiness can be queried by the owning host but never serves frontend assets/auth callbacks to arbitrary browsers. Request auth uses constant-time capability comparison, exactly one header, and rejects Origin-bearing browser requests. No CORS permission is added. API router still validates route/path/body and audit intent before JDBC.

- [ ] Write failing real-HTTP tests with isolated synthetic JDBC: absent/wrong/duplicated capability returns 401; browser Origin, non-loopback bind, OAuth endpoints and native capability used as MCP Bearer are rejected; valid capability can save/connect/inspect columns/query/export/audit as local Actor. Actor headers cannot choose another owner. Numeric server cookies cannot enter local mode; local capability cannot enter server mode.
- [ ] Add startup/process tests: missing/oversized/duplicate-key bootstrap, protocol mismatch, malformed secret, stdin EOF before/after readiness and locked data fail cleanly; capability/key never appear in stdout/stderr. A competing process on a fixed unrelated port is never contacted.
- [ ] Implement strict bootstrap and LocalAuth; emit readiness only after stores/lock and socket bind. Keep stdin lifecycle watcher active after the first line, close app/lock on EOF. Do not add an environment-only `AUTH_DISABLED` escape hatch to the server.
- [ ] Run negative tests and server GitHub/MCP HTTP suites. Require typed JSON errors and unchanged audit semantics; writes are never automatically retried after an uncertain response.
- [ ] Review checkpoint: independently review local/server boundary before UI can use it.

### Task 4: Opt-in local MCP using existing policy

**Files:** Create `LocalMcpControl.java`, `LocalMcpTest.java`; modify `McpServer.java`, `McpApi.java`, `LocalEngineMain.java` and local settings handling in `LocalWorkspace.java`.

**Interfaces:** `LocalMcpControl.setEnabled(boolean enabled,int port)` binds a separate 127.0.0.1 listener; persisted setting defaults false, default requested MCP port 4174. When enabled persists until explicitly disabled; occupied port reports error, never attaches or silently chooses another service. Broker-managed `GET/PUT /api/local/mcp` returns `{enabled,endpoint}` (never capability); token management uses actual endpoint and trusted local Actor. Disabled listener does not accept requests; existing token records remain revocable in Settings.

- [ ] Write failing tests: no listener by default, explicit enable requires native capability, MCP accepts only its own bearer tokens, local capability rejected, grants do not expand on profile edits, read_only requires dedicated declared profiles, disable closes listener, restart honors saved explicit enable/port and reports conflicts. Local MCP audit records local Actor + token identity without secrets.
- [ ] Implement control around existing McpServer worker/SQL policy rather than a second SQL path. Decouple trusted MCP origin/endpoint configuration from GitHub OAuth config for this local listener only. Keep existing 20-token, 64-KiB-body, 500-row/1000-metadata/1-MiB-response limits and generation rules.
- [ ] Run existing MCP suites and actual SDK probe against local fixtures. Verify full_access never bypasses database permissions/read-only ceiling and no desktop-modal claim is made for AI requests.
- [ ] Review checkpoint: listener and auth separation proven.

### Task 5: Cross-platform native supervisor, broker and key providers

**Files:** Create `packages/local-engine/package.json`, `index.js`, `protocol.js`, `test/supervisor.test.js`, `test/protocol.test.js`; create `desktop/key-store.cjs`, `desktop/test/key-store.test.cjs`.

**Interfaces:** Implements EngineClient and broker contracts above; manifest `engine/manifest.json` gives schema1, protocol1, app version, platform/arch, Java relative executable, immutable classpath resources and checksums. Broker resolves only manifest-owned paths, no shell; Java gets a scrubbed environment with no JAVA_TOOL_OPTIONS/JDK_JAVA_OPTIONS/CLASSPATH/plugin flags inherited from workspaces. Packaged native SQLite extraction uses private temp storage.

- [ ] Write failing tests using actual short-lived child fixtures: ready/no-ready/exit/error/protocol mismatch, timeout, parent stdin close, idempotent stop, children with paths containing spaces/non-ASCII, no PATH java dependency, no shell interpolation. Deny absolute URLs, URL userinfo/encoded traversal, unknown routes/verbs/headers, >64-KiB request and >16-MiB response; refuse cross-origin redirects, never follow them with capability headers. Stop has 5s graceful deadline then kills only the exact owned child.
- [ ] Define API allowlist for existing connection CRUD/test/connect/disconnect, metadata, query, activity/export, token routes and `/api/local/mcp`; whitelist query parameter keys per route and set actor headers internally. IPC results expose safe HTTP data/request IDs, never transport Authorization or bootstrap material. Diagnostics redact secrets by construction, not by printing raw errors first.
- [ ] Implement EngineClient startup over private stdin/stdout with authenticated capability health check after readiness; preserve request cancellation/uncertain-write state. Dropped request or engine exit never auto-resubmits writes.
- [ ] Implement desktop key provider with Electron safeStorage: `loadOrCreateKey(dataDir,{allowPlaintextFallback}): Promise<Buffer>`. Test available encryption + encrypted key reopen, corrupt/missing key refusal, Linux backend `basic_text`/unavailable requiring explicit persisted consent, and Windows encrypted storage failure rejecting startup. Raw fallback file is allowed only after Linux consent and private permissions; settings contain only consent flag, never key. Do not change protection format implicitly when keyring availability changes.
- [ ] Run package tests and real Java local-engine process tests with packaged fixture dependencies. Verify active engine remains isolated from `npm run check` and parent termination closes it.
- [ ] Review checkpoint: broker/key lifecycle reviewed before Electron exposes it.

### Task 6: Electron shell and shared frontend adapter

**Files:** Create `desktop/package.json`, lockfile, `main.cjs`, `preload.cjs`, `protocol.cjs`, `startup.html`, `startup.js`, `test/bridge.test.cjs`, `test/desktop.e2e.cjs`, icons; create `public/local-session.js`, `public/runtime-transport.js`, `test/local-session.test.js`; modify `public/app.js`, `activity.js`, `mcp.js`, `index.html` and shared controller/session tests only where native-mode transport/labels/export need hooks.

**Interfaces:** Custom origin `gridbase://app` serves only packaged allowlisted assets. Desktop HTML entry selects `local-session.js` instead of loading the browser GitHub session script; server index/session behavior stays compatible. Runtime transport chooses trusted frozen local bridge or existing browser fetch, never a query-string mode switch. Existing native bridge is installed by preload with sender/origin checks. Browser cache keys remain exactly `...:github:<id>`; native keys use explicit local owner prefix. SQL draft/history stay out of credential storage and results remain nonpersistent.

- [ ] Write failing tests for local boot without network/GitHub, local label not shown as @GitHub, hidden logout/replaced Close action, native bootstrap failure/recovery, local/server cache separation, sidebar metadata, correct selected SQL and confirmation-before-send for UPDATE/DELETE including keyboard/CTEs. Existing browser session-expiry and account-switch concealment tests must still pass.
- [ ] Implement Electron single-instance lock, controlled custom protocol/CSP (`connect-src 'none'` for renderer), sandbox/isolation settings, validated IPC sender and allowlisted bridge. Block web navigation/new windows and arbitrary external URLs. No capability can be read from renderer or DevTools state. IPC does not expose unrestricted invoke channels.
- [ ] Adapt existing UI narrowly: local settings include profile label, MCP toggle and keyring fallback consent; current one-time MCP token reveal remains explicit text-only UI and is erased on close. Connection password input/Edit values may exist transiently in form memory but never persist in renderer storage or diagnostics. Keep all existing JSON formatting and audit warnings.
- [ ] Implement native export: existing audit call must succeed before host opens save dialog/writes bounded CSV/JSON; renderer cannot choose arbitrary filesystem paths. User cancel has no file effect. Native confirmation is always called before mutation dispatch; no auto-retry.
- [ ] Run Electron end-to-end using isolated data/synthetic JDBC: startup, add/connect, metadata columns, selected SQL, cancel/approve UPDATE/DELETE, JSON detail, export/cancel, log SQL, quit, reopen persistence, backend crash. Assert injected HTML is text and cannot reach host APIs. Verify no external request is needed at startup.
- [ ] Review checkpoint: native UI evidence and unchanged server tests.

### Task 7: Reproducible engine bundle and native installers

**Files:** Create `scripts/package-engine.js`, `scripts/engine-dependencies.json`, `test/package-engine.test.js`, `desktop/forge.config.cjs`, `desktop/scripts/package.cjs`, `desktop/THIRD_PARTY_NOTICES.md`, `docs/DESKTOP.md`; add root build/test/check commands and package metadata; create `.github/workflows/desktop.yml` without changing existing web release semantics prematurely.

**Interfaces:** `node scripts/package-engine.js --target linux-x64|win32-x64 --out <absolute-dir>` produces `engine/{manifest.json,runtime/,app/,drivers/,licenses/}`. Downloads happen only during build; every Java/JDBC artifact has pinned version/URL/SHA-256/license in the dependency manifest. Compile with --release17 and preserve dependency order (pinned Gson before Spark-bundled Gson). Include complete tested Hive dependency closure, not a guessed minimal list. Java runtime and SQLite native loading must work without developer paths.

- [ ] Write failing packaging tests for missing dependency/hash mismatch, network unavailable with complete cache, unsafe archive paths, wrong OS/arch, writable-runtime assumptions, resource path spaces and manifest mismatch. Require output inventory and checksums, no .env/data/credentials/test fixture secrets. Establish reproducible dependency inventory and include notices for runtime, Electron and JDBC/transitives.
- [ ] Build a native Java17 bundle on each OS, smoke-load all drivers/SQLite and local entrypoint using only bundled runtime. Test PostgreSQL/MySQL fixtures; Hive test service verifies metadata/SELECT and supported credential paths, with unverified production/storage privileges stated explicitly.
- [ ] Configure Forge Windows .exe installer and Linux .deb with explicit OS prerequisites, desktop shortcut/icon, per-user writable data, no admin requirement for normal execution, offline first launch after installation. Signing secrets only from authorized CI secret storage; label unsigned evaluation builds. Auto-update remains absent.
- [ ] Add workflow for PR/manual build/test artifacts with read-only default permissions, pinned actions/tool versions and platform cache keyed by dependency hashes. Do not dispatch/upload remotely until authorized. Windows hosted server runners can build packages, but Windows11 installer behavior still requires a Windows11 test machine/runner; record that gate explicitly.
- [ ] Document install/upgrade/uninstall/data backup, local no-password boundary, Linux keyring fallback, MCP opt-in/port conflict, and unsupported remote/ARM/macOS scenarios. No claims of distro support merely because .deb exists.
- [ ] Review checkpoint: package inventory, checksum and native installer evidence; no release until Task 8 passes.

### Task 8: Installed-app acceptance and delivery gate

**Files:** Extend `desktop/test/desktop.e2e.cjs`, add `desktop/test/installed-smoke.cjs` and `docs/verification/standalone-desktop.md`; update version/release notes only after actual base version and delivery authorization are resolved.

- [ ] On clean Ubuntu24.04 and Windows11 x64, install actual .deb/.exe, allow declared install prerequisites, remove Java/Spark from PATH, block external Internet, then launch using the installed shortcut. Record artifact checksum, OS version, Java/driver inventory and real output/screenshots; never use production credentials in evidence.
- [ ] Exercise DB/History/Logs/Settings, PostgreSQL/MySQL fixtures and Hive fixture, query/column metadata, confirmation cancellation, JSON details, native export, opt-in MCP SDK read_only/full_access policy and token revocation. Missing Hive test service is an explicit acceptance gap, not a passed test.
- [ ] Test backend crash, parent crash/EOF, app quit/SIGTERM, conflicting MCP port, keyring unavailable, private-storage failure and second instance. Confirm no orphan backend, no unintended write retry and no LAN listeners. Do not expose credentials in process arguments/logs.
- [ ] Create a saved profile and audit marker, upgrade by reinstalling a newer test package, reopen and decrypt successfully, uninstall and verify data is preserved. Explicit data deletion is separate, warned and user-controlled. Test local/server data isolation and compatibility with an existing server-mode store fixture.
- [ ] Run full root `npm test`, `npm run check`, desktop/native package tests, schema validation and independent whole-branch security/release review. Re-run focused tests after any fixes. Record unverified platforms/blockers plainly.
- [ ] Hand over installer absolute paths/checksums and test report. Ask separately for commit/push/release/signing/CI actions if not already authorized; prepare one compatible MINOR version after 1.3.2 integration, not a bump per task. Keep legacy web release published state distinct from native installer delivery.

## Self-review and handoff

Every approved spec area maps to Tasks 1–8; local account/auth, ACL/keyring, immutable runtime, Windows resources, manual upgrades, desktop functionality, opt-in MCP and actual native verification are covered. VS Code implementation is deliberately separate in `2026-11-18-standalone-vscode.md`, consuming the contracts here after desktop acceptance. Proposed execution: subagent-driven with serial integration at Tasks 1–5 security/identity boundaries and independent final review; avoid parallel edits to actor/router/store files. Await plan review and execution-method choice before implementation.
