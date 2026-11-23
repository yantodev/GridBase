# Native-owned local engine (host only)

`const {EngineClient} = require('@gridbase/local-engine')` (or the bundled relative module).

- `await EngineClient.start({bundleDir,dataDir,tempDir,clientKind,credentialKey})` validates the immutable distribution and launches its manifest-owned Java through the fixed Linux exec-only launcher. Only Node's main thread may own the engine (not a Worker). `clientKind` is `desktop` or `vscode`; the copied credential key must be a 32-byte Buffer. Caller must derive `bundleDir` from trusted installed application resources, never a renderer/workspace-selected value. All three directories must be absolute, nonsymlinked and separate; existing data/temp modes are never repaired.
- `await client.request({method,path,body?,signal?})` returns `{status,headers,body}` with a serialized UTF-8 body. No caller headers, endpoint, executable, options or environment are accepted. Validation errors use `INVALID_REQUEST`. Internal transport errors are fixed messages/codes; no raw Java/HTTP errors are forwarded. A submitted POST/PUT/DELETE failing to obtain a complete permitted response has `uncertainOutcome:true`; the host must show that state and must **not** retry automatically. Aborting HTTP does not prove JDBC cancellation.
- `await client.stop()` closes the bootstrap stdin pipe, waits up to five seconds, then kills only its own ChildProcess and awaits close. Repeated calls share completion. `client.onExit(listener)` receives only `{code,signal}` and returns an unsubscribe function. Keep client and key provider exclusively in the trusted native host; renderer IPC must expose only the narrow request facade.

Startup deadline 30s; request deadline 30s; ready/bootstrap lines <=8192 bytes. Per-request path+JSON limit 64 KiB, SQL 20000 JS string code units (matching current Java limit), response 16 MiB including chunked bytes. No business retries and no redirect following. Filtered response headers: JSON `content-type`, canonical UUID `x-request-id`, and `x-gridbase-audit-warning` **only with exact value `incomplete`**. Preserve that warning in the later native fetch adapter so completed operations with failed audit completion remain visible. Audit identity comes from authenticated local session, not IPC headers.

## Manifest

`engine/manifest.json` has exactly `{schema:1,protocol:1,version,platform,arch,java,resources,classpath,files}`; platform `linux` or `win32`, arch `x64`, semver version. Java/resources/classpath paths are relative; `files` is `[{path,sha256}]` for every regular distribution file except the manifest itself. Inventory is full-distribution, including JVM runtime libraries; dereference runtime symlinks when packaging. Directory inventory also rejects case aliases. No wildcard classpath, unknown fields, duplicate JSON keys, escape paths, symlinks, hardlinks, missing/unlisted files or checksum mismatch. Resources contain matching VERSION and public/. Manifest max 1 MiB, JSON depth 32, bounded token/entry counts. Integrity is against the trusted distribution root; this is not a signature/verifier for an untrusted root and cannot prevent a trusted owner replacing files after validation.

## Linux exec-only parent-death launcher

Linux distributions must include **`engine/native/gridbase-launcher`**, a regular executable covered by the same manifest `files` inventory. Schema1 has no new keys or caller-selected launcher path. Missing/unsafe/unlisted/tampered launchers fail closed; there is no direct-Java fallback. The launcher and Java cannot have setuid/setgid bits or file capabilities, and Java must be a regular ELF image, not a shebang interpreter. Unsupported/denied capability-xattr inspection fails closed. Linux package/filesystem compatibility must be verified at packaging time.

Build only during packaging/tests: `node packages/local-engine/native/build.cjs /absolute/generated/output`. This uses fixed `/usr/bin/cc`, libc/Linux APIs, deterministic hardened flags and no downloaded dependency. Never compile at end-user startup; distribute the reviewed generated binary and inventory its SHA256. No binary is tracked. Task7 must include it in every Linux image.

The trusted main-thread host supplies only its expected PID, manifest-owned absolute Java and the fixed Java argv. The launcher verifies expected parent **before and after** arming `PR_SET_PDEATHSIG(SIGKILL)`, uses `PR_SET_NO_NEW_PRIVS`, then `execve` in place with Node's scrubbed environment; private stdin/stdout/stderr and PID are unchanged. Native failures emit only `Local engine launch refused.` and exit126, without paths, arguments or bootstrap. It neither forks a JVM grandchild nor runs a reaper daemon. Direct launcher arguments are an internal host contract, not a renderer API.

PDEATHSIG is tied to the Linux **thread** which spawned it: EngineClient refuses Worker ownership before state creation and must remain on Node's main thread. No privilege/credential-changing code is permitted in the reviewed packaged runtime, because such changes can clear the death signal. Ordinary trusted Java exec preserves it. Privileged exec is rejected (not merely assumed ordinary); NNP is additional defense confined to this child, not a change to server/host security settings. PID-bound actual Node-host tests cover idle and blocked JDBC death. A host which remains alive still gets unchanged stdin EOF / five-second grace / exact-child kill semantics. An abruptly dead host instead causes immediate kernel SIGKILL, an **uncertain operation outcome, not rollback**; there is no query resubmission. The kernel may retain a dead orphan as a zombie until its parent/subreaper reaps it; it is no longer executing or holding workspace locks.

References: [PR_SET_PDEATHSIG](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html), [PR_SET_NO_NEW_PRIVS](https://man7.org/linux/man-pages/man2/PR_SET_NO_NEW_PRIVS.2const.html), [execve](https://man7.org/linux/man-pages/man2/execve.2.html). Distribution trust remains required; this is not authentication for a same-user attacker-controlled bundle.

## Broker routes

Connection IDs `test`, `connect`, and `disconnect` are not reserved: GET/DELETE use normal ID detail/deletion semantics; only POST selects those action handlers. GET/DELETE bodies and additional verbs remain denied.

GET healthz, auth/session, api/health, connections; POST connection save/test/connect/disconnect; GET/DELETE connection ID; GET databases/namespaces/tables/columns with only connectionId/namespace/table as appropriate; POST query; GET activity with mine-only scope/from/to/action/outcome/connectionId/cursor/limit; POST activity/exports; GET/POST mcp/tokens and DELETE canonical UUID token; GET/PUT local/mcp. All API routes start `/api/` except `/healthz`. No admin activity/users, auth/logout/OAuth, static, MCP execution or generic URL/header bridge. Connection, token, query/export and local-MCP bodies follow current Java field schemas.

## Desktop key adapter for Task 6

`desktop/key-store.cjs` exports `loadOrCreateKey(dataDir,{allowPlaintextFallback}) -> Promise<Buffer>` and host-only `createKeyProvider({app,safeStorage,platform?})` for controlled adapters. Call after `app.whenReady()`. Default lazily requires Electron; no Electron package is installed by Task 5.

Adapter matches the **Electron 45.4.1 asynchronous** contract: `app.isReady():boolean`, `safeStorage.isAsyncEncryptionAvailable():Promise<boolean>`, `encryptStringAsync(string):Promise<Buffer>`, `decryptStringAsync(Buffer):Promise<{result:string,shouldReEncrypt:boolean}>`, and Linux `getSelectedStorageBackend():string`. No deprecated synchronous calls or force-plaintext Electron flag. Check backend plus ciphertext provider tag: Electron 45.4.1 pins Chromium 156.0.8078.100, whose POSIX fallback is v10, SecretService v11 and SecretPortal v12. Availability alone is **not** proof of encryption: reject v10/unknown output even when async availability reports true. Existing `shouldReEncrypt` never triggers implicit rewrite. Any Electron/Chromium pin change requires reviewing these tags and running real keyring tests. Unsupported newer formats fail closed.

`credential-key.v1` is binary: `GBKEY1\0`, mode byte (1 encrypted, 2 explicit Linux plaintext), backend-name length byte, payload length uint32BE, ASCII backend, payload, SHA-256 of preceding bytes. Mode 1 contains safeStorage encrypted canonical base64url key; mode 2 contains exactly raw 32 bytes after explicit Linux consent. Checksum catches accidental corruption, not malicious same-user modification. `key-consent.v1.json` contains **only** `{allowPlaintextFallback:true}` and is private. Persisted fallback continues unchanged even if a keyring appears later; encrypted files never downgrade when it disappears. Missing/corrupt key with existing data is refused, never regenerated.

A private exclusive `.credential-key.init` claim coordinates host processes; key and consent use O_EXCL/NOFOLLOW with atomic 0600 creation under 0700 current-user storage. Readers refuse partial claims/files. Successful owner removes its claim only after reopen verification; failed claims remain fail-closed and require explicit operator recovery (no automatic overwrite). Slow contenders reopen a completed winner without stranding a claim. Linux path checks reject unsafe ancestors, ownership, symlinks and hardlinks. Same-user processes remain within the native-host trust boundary.

**Windows is blocked**, not cross-platform complete: Node built-ins cannot prove protected private creation/reparse invariants. Both key and engine initialization reject with `WINDOWS_PRIVATE_STORAGE_UNSUPPORTED`. Minimal trusted-helper/native-test proposal is in task-5-report.md. Controlled fake safeStorage adapter tests are not actual OS keyring evidence.

### Windows host components behind the fixed gate

Task5B adds internal adapters, **not Windows support or an activation option**.
`assertSupportedPlatform('win32')` still refuses before engine/key side effects;
public `EngineClient.start` and default key APIs are unchanged. No environment,
option, endpoint, executable or platform override enables them. Task6 must not
wire these components into a supported desktop until native acceptance/review.

- `windows-manifest.loadWindowsManifest(session,bundleDir)` borrows an existing
  `HostPrivateFilesSession`, opens/closes only its bundle handle and uses only
  native read-only bytes/streamed inventory. `manifest.loadManifest` selects it
  on Windows and owns its helper session. Exact schema1 requires both fixed
  `engine/native/win32-x64/gridbase-{private-files,launch-owned}.exe` assets.
  Known native fixture/instrumented EXEs are forbidden in distributions. Native
  identity/size remain BigInt internally, never JSON or lossy Number values.
  The trusted installed root is an installer/host prerequisite: hashing the
  helper does not authenticate the root that was used to launch it.
- `desktop/windows-key-store.cjs` exports host-only
  `createWindowsKeyProvider({session,app,safeStorage,platform?})`, returning
  `loadOrCreateKey(dataDir,{allowPlaintextFallback})`. Session is externally
  owned and remains open; this provider closes only roots it opened. The
  fallback flag is accepted for contract compatibility but never authorizes
  Windows plaintext or consent. Only win32 mode1 `windows-dpapi`, pinned
  Electron45.4.1 async API and exact `v10` ciphertext are accepted. No Linux
  backend query, rewrite on `shouldReEncrypt`, migration, failed-claim removal
  or regeneration of missing/corrupt established keys. Raw key never enters
  filesystem RPC. Linux envelope bytes/backend/fallback behavior are unchanged.
- `owned-engine-client.startOwnedEngine(owned,{version,credentialKey,clientKind,deadline})`
  is the shared host-only authenticated lifecycle, not a public launch API.
  Windows coordination uses `launchOwned`'s actual `expectedJavaPid`; Owned
  alone is not readiness. One absolute 30s launch/readiness/authentication
  deadline includes BindHost/Owned/bootstrap. Stop delegates EOF/grace/exact
  process proof to the owned wrapper, without a second broad PID timer.
  Wrapper-only closure yields public `{code:null,signal:null}`; only observed
  Java terminal proof supplies an exit code. Submitted failed mutations remain
  uncertain and are never retried. Linux keeps its same-PID exec launcher,
  main-thread ownership, five-second exact-child stop and authenticated facade.

Host tests run real Node binary-RPC/staged-wrapper processes with synthetic
inventory/HTTP and controlled safeStorage. These establish host semantics only,
not WinAPI, Java Windows ACL, DPAPI or installed-root proof. The genuine native
Electron/JRE fixture in `desktop/test/windows-native-host.test.cjs` explicitly
SKIPs outside Windows. On Windows it requires an **empty disposable profile**
(`GRIDBASE_WINDOWS_DISPOSABLE_PROFILE=1`), actual pinned
`GRIDBASE_WINDOWS_ELECTRON`, a trusted prepackaged fixture-only
`GRIDBASE_WINDOWS_NATIVE_BUNDLE` with real JRE17, and private
`GRIDBASE_WINDOWS_OBSERVATIONS`. It performs create/quit/reopen with unchanged
key/envelope digests and actual authenticated engine lifecycle; it does not
provision accounts, download Electron/JRE or bypass sandboxing. Fixed KnownFolder
fixture data is retained for inspection/recovery, not silently deleted. Missing
prerequisites on Windows fail, rather than becoming a mocked pass. Full Windows11
other-user/ACL/reparse/JRE/SQLite/DPAPI/job/blocked-JDBC and installer acceptance
remain prerequisites; crossbuild/source review are not native acceptance.

## Tests

`npm run test:local-engine` uses real short-lived Node children and a dereferenced Java 17 fixture bundle copied from build/java-tests plus verified dependency pins. Run root `npm test` to compile those test classes first. No active build/java, build/java-runs, server stores, service endpoint or .env is read. `npm run test:key-store` tests controlled async adapters plus actual competing Node hosts. Root test/check include these gates. Java fixture copies Ubuntu's JDK runtime while omitting optional broken src.zip (not runtime code); Task 7 packaging must build a proper distributable image.
