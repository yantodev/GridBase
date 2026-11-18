# GridBase standalone clients: offline desktop and VS Code

Status: approved by the user after builder check. Installation may use the Internet; normal installed-app operation is offline. No desktop/extension product code implemented by this document.

## Intent and approved decisions

The user selected standalone clients (option A), then explicitly selected a local/offline account without GitHub login. The user allows network access during installation to obtain system prerequisites; normal operation and first application launch after successful installation must not require GitHub or Internet access. Database connections execute from the user's machine; no GridBase application server, Docker, separately installed Java, or local Spark cluster is required. A database server and network/VPN connectivity are still needed for remote databases. Existing web/server mode must retain GitHub authentication and account isolation.

The earlier recommended delivery order is desktop first, VS Code second. This design makes that sequencing explicit. Each phase must produce an installable, independently testable artifact; a plan or an untested installer does not count as delivered software.

## Approaches

1. Electron shell with bundled Java/JDBC engine (recommended by assistant; standalone selected by user). Reuses existing HTML/CSS/JS and Java policy/audit code; requires packaging Chromium and Java plus drivers.
2. Tauri shell with the same engine. Potentially smaller shell but adds Rust and OS webview variability; not proposed for the first delivery.
3. Remote clients of an existing GridBase server. Smaller packages but contradicts the user's explicit standalone choice.

Proposed implementation: option 1. VS Code is a separate extension using its extension host instead of Electron as the native supervisor. Share engine distribution and frontend transport contracts, not two SQL implementations.

## Initial scope and proposed defaults

- Proposed initial OS baseline: Windows 11 x64 installer (.exe) and Ubuntu 24.04 LTS x64 installer (.deb), tested on those systems. Other Windows versions and Debian/Ubuntu derivatives are not advertised as supported until tested. No native ARM, macOS, or alternative Linux package formats initially.
- Installation may fetch declared OS prerequisites with explicit installer/user approval. Bundle Java/JDBC in the distribution, not an unverified first-launch downloader. After installation completes, application startup, local profile/settings management and operation against reachable databases do not require Internet or GitHub. Fully offline clean-machine installation is not a requirement. List OS prerequisites and test installed-app startup with external networking disabled; remote database access still requires its network/VPN.
- Offline account: one local profile per OS user and application data directory, no application password or GitHub login. This is an OS-user security boundary, not an application vault protecting against another process running as that same OS user.
- Desktop and VS Code initially have separate private data directories and separate engine instances. Reuse runtime code, not a live SQLite database or implicit shared session. No automatic import of the server's existing data directory.
- Local identity has an explicit local provider namespace; never counterfeit a numeric GitHub ID. Generalize actor identity at a narrow boundary and retain existing GitHub-owner records, encryption AAD and browser cache semantics in server mode. Profile/connection/SQL audit remains available for local actors.
- Preserve current query dialect behavior, UPDATE/DELETE confirmation, result limits, JSON details, audit SQL logging and MCP restrictions.
- Build-isolation 1.3.2 changes already in the worktree remain intact; no unrequested commit/push/release/restart or edits to credentials/production data.

## Shared packaged engine

- Build once for Java 17; distribute compiled application classes/JARs, not source compiled on the user's machine.
- Bundle a platform-specific Java 17 runtime, PostgreSQL/MySQL/Hive JDBC dependencies and required transitive libraries, plus third-party license notices. Users need no JDK or Spark installation. Database/storage endpoints are not bundled.
- Keep runtime resources immutable. Add explicit resource, data and temporary-directory configuration independent of working directory. No `.env` copied from the development checkout or read from arbitrary workspace directories in packaged local mode.
- Store data in per-user application storage: desktop OS application-data path; extension `globalStorageUri`. Keep SQLite profiles, key material and audit outside install/update directories. Manual update preserves data; uninstall does not delete data without explicit consent.
- Per-data-directory process lock prevents two engine instances from concurrently managing the same local workspace. Desktop uses single-instance activation; extension host owns its engine and shows a clear error on lock conflict.
- Native supervisor starts a child Java process without shell interpolation, with a private working/temp directory and a new immutable runtime path. Wait for bounded health/readiness, detect early exit/crash, stop the owned child on quit/dispose, and never kill arbitrary Java processes or reuse an unverified service on an occupied port.

## Local authentication and transport

No GitHub login does not mean unauthenticated HTTP.

- Local mode is explicit and separate from default server mode. It binds loopback only, selects an ephemeral port via the server socket, and rejects non-loopback binding/configuration.
- Supervisor generates a cryptographically random per-launch capability (at least 256 bits), delivers it using child stdin/private IPC, and retains it only in native-host/engine memory. Do not put it in arguments, URLs, persisted settings, logs, renderer DOM, webview state or exported data.
- Readiness contains only protocol/version/PID/loopback port, never the capability. Native host verifies the child lifecycle and private handshake rather than attaching to an arbitrary endpoint with a matching `/healthz`.
- Local business routes require the capability, enforce a dedicated local auth scheme, and resolve the actor from the trusted local runtime identity. Client-supplied actor IDs do not select owners.
- Electron main / VS Code extension host brokers frontend API calls, validates allowlisted methods/routes/payload sizes and attaches the capability only to that exact engine endpoint. No generic fetch/shell/filesystem API is exposed to the UI.
- Server browser cookies and MCP bearer tokens remain distinct. Local capability must not authenticate server mode or be usable as an MCP token. Existing MCP scopes/grant generations/read-only profile constraints stay intact.
- Local MCP is disabled by default; enabling it explicitly starts a separate loopback MCP listener/endpoint with existing token lifecycle and limits. It is not exposed to the LAN. UI explains that AI-client approvals, not desktop confirmation, govern MCP writes.
- General identity support must have regression tests proving local identities cannot claim GitHub-owned profiles/audit in server mode, and old server stores/cache remain readable. No automatic owner rewriting or merging of local and GitHub identities.

## Platform storage security

- Centralize private directory/file creation for profiles, credential keys, audit and MCP stores. Linux uses owner-only POSIX permissions. Windows uses explicit owner-only ACL protection, with any necessary SYSTEM/administrative access documented, and verifies the actual policy. Reject unsafe/symlink/reparse targets rather than silently skipping checks.
- New SQLite/WAL/SHM files inherit private-directory protection. Unsupported/unverifiable permission backends fail closed with an actionable startup message, not a partially started app.
- Integrate local encryption-key protection with platform-backed storage where available; extension-managed secrets use VS Code SecretStorage. On Linux without a secure keyring, require explicit acceptance of a clearly described OS-permission-protected local-key fallback before persisting credentials. Do not claim that encrypted SQLite plus a nearby key protects against the same OS account.
- No bearer/GitHub/database secrets in renderer storage, settings.json, crash reports, launch command lines or release packages.

## Desktop UI and lifecycle (phase 1)

- Reuse GridBase workbench UI with a local transport adapter and local session descriptor. Replace GitHub account/logout actions with local-profile identity, settings and lock/close behavior appropriate to offline mode; no dead GitHub login screen.
- Load packaged UI through a controlled custom protocol with strict CSP. Electron renderer has Node integration disabled, context isolation enabled and sandbox enabled. Validate IPC sender and message shape; reject remote navigation/new windows except validated external help links opened by the native host.
- Backend result strings remain text-rendered and cannot invoke host APIs.
- Keep DB, History, Logs and Settings. Preserve keyboard SQL execution, confirmations, independent connections, result export and JSON details. Native export uses a save dialog and bounded validated messages.
- Clear startup/error UI covers missing/corrupt bundled runtime, incompatible driver, permission failure, locked data, port conflicts and backend crash. No writes automatically retried after an uncertain outcome.
- First release uses manual signed/checksummed downloads from GitHub Releases; automatic update is deferred. Code signing Windows is a separate distribution prerequisite requiring user-controlled signing credentials. Unsigned test builds may be supplied but must be labeled as such; do not promise absence of SmartScreen warnings.

## VS Code extension (phase 2)

- Desktop Node extension, initially local Windows/Linux x64 only. `extensionKind` keeps backend local to the VS Code UI machine. Do not advertise vscode.dev, Codespaces, Remote SSH host execution, WSL-host execution or Dev Containers as supported in the first version; explain that connections use local-machine networking even when a remote workspace is open.
- Ship platform-specific .vsix artifacts with the same Java engine/runtime. No shell scripts or JDK install required. Packaging with `@vscode/vsce`; sideloading does not require Marketplace registration. Marketplace publishing needs a chosen publisher and authorization later.
- Native tree view for connections/schema/table/columns, commands for connection management and running selected/current SQL from editor, Webview for results/JSON details. Follow VS Code theme/accessibility and use native confirmation UI for UPDATE/DELETE.
- Extension host owns the process, all secrets and API broker. Webview loads only approved resources via `asWebviewUri`, restrictive localResourceRoots and CSP; messages are typed and validated. No webview direct cookie workaround or arbitrary localhost access.
- Do not activate/start a JDBC process for untrusted workspaces; require Workspace Trust for execution. Do not accept executable paths, JDBC drivers or launch flags from an untrusted workspace. Connection operations are always explicit.
- Disposing/reloading extension cleans up owned processes; output channel has redacted diagnostics. Extension updates preserve global storage and require explicit engine/protocol compatibility checks.

## Build, release and verification

- Native GitHub Actions matrix builds/tests on Linux x64 and Windows x64. Pin dependencies, verify downloaded Java/driver digests, produce checksums and third-party notices, and scan artifacts for secrets.
- Run existing Node/Java suites and preserve server GitHub auth and MCP contracts. Add local-auth negative HTTP/IPC tests, storage permission tests per OS, lifecycle/port-conflict/crash tests, upgrade preservation, and real installed-app smoke tests.
- Validate desktop install/launch/quit/uninstall on each supported OS; exercise real UI using isolated JDBC fixtures, then PostgreSQL/MySQL integration fixtures. Spark/Hive functionality needs an appropriate test service; do not claim production/storage privilege verification.
- VS Code tests exercise commands, tree metadata, selected SQL, cancellation/confirmation, results and process cleanup in the actual extension host on both target OSes.
- A Windows cross-build on Linux is not proof of Windows install/run. Any missing signing credentials, CI authorization, Windows runner or Hive fixture is reported as a blocker/limitation, not replaced by fabricated results.
- Scope is compatible new distribution support; propose a MINOR release for desktop after the existing 1.3.2 fix is integrated. Resolve actual base version before release; no bump-per-edit or publication without authorization.

## Acceptance gates and non-goals

Phase 1 done: tested Linux and Windows installers may acquire declared OS prerequisites during installation; the installed applications start and run offline without GitHub/Java/Docker setup or first-launch downloads, local auth and private storage are verified, core workbench functions work, data survives manual upgrade, and server-mode regressions remain green.

Phase 2 done: tested .vsix on Linux/Windows starts/stops its local engine, executes editor SQL with correct safety/account rules, shows metadata/results, stores secrets securely, and supports explicit offline use without an external GridBase server.

Not in initial delivery: multiple local application accounts/passwords, automatic migration from GitHub/server data, automatic cross-client profile sync, cloud synchronization, auto-update, macOS/ARM, arbitrary Linux distro packaging, browser extensions, or remote extension-host execution. No promise of database connectivity without the user's required network and database credentials.

## Approval

The user approved this design, including proposed defaults and phase order: one local profile per OS user, separate desktop/extension data, initial x64 .exe/.deb/.vsix targets, and the offline no-password trust boundary. Next write separate implementation plans for shared engine/desktop and VS Code. Implementation follows the reviewed plan and an execution-method choice.

## Builder check disposition

The builder check identified one important planning gap: minimum supported OS versions and whether a clean-machine installation/first launch may use the network for system prerequisites. The initial baseline is Windows 11 x64 and Ubuntu 24.04 LTS x64. The user confirmed: installation may use Internet to install prerequisites, then operation stays offline, and approved the complete design. CI/install tests must cover actual native dependencies (including SQLite native loading, Electron system libraries and credential-storage services), not merely Java/JDBC presence. No unresolved builder questions remain.
