# Reproducible shared-engine bundle (Task7A)

This is the shared Java/JDBC engine artifact, **not a desktop installer**. Version
remains 1.4.0. It does not start/download anything at installation or first launch.
The reviewed native host supplies Node; engine startup itself requires no system
Java/JDK, Spark, Python, compiler, package manager, or Internet connection.

## Build prerequisites and commands

Current build tooling is Linux x64 only: Node 24+, Python 3 stdlib, a trusted JDK
17 (`JAVA_HOME`), `/usr/bin/cc` and normal libc headers. Windows-target metadata
crosspacks additionally require the existing MinGW x64 compiler/objdump paths in
`packages/local-engine/native/windows/build.cjs`. Native Windows build tooling is
not implemented here. No new npm dependencies or dependency-lock changes.

Use private scratch storage for `TMPDIR`, cache and outputs. Output's parent must
exist; the output itself must be an absolute **new** directory (even an empty
existing directory is refused). Cache is explicit, absolute, nonsymlink, builder-owned, not group/world-writable,
and must not overlap output. Nothing recursively deletes or overwrites an existing output.

```sh
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$PATH"
export TMPDIR="$HOME/.hermes/cache/scratch" # or your private build scratch
npm run build:engine -- --target linux-x64 \
  --out "$TMPDIR/GridBase Linux ü engine" --cache "$TMPDIR/gridbase-engine-cache"
# Once all selected pins are cached, build without any network fetch path:
npm run build:engine -- --target linux-x64 \
  --out "$TMPDIR/GridBase Linux ü engine repeat" \
  --cache "$TMPDIR/gridbase-engine-cache" --offline
npm run build:engine -- --target win32-x64 \
  --out "$TMPDIR/GridBase Windows metadata" \
  --cache "$TMPDIR/gridbase-engine-cache" --offline
npm run test:package-engine
npm run check:package-engine
# Real Linux acceptance diagnostic; destination must also be NEW:
node scripts/package-engine/smoke.js \
  "$TMPDIR/GridBase Linux ü engine" "$TMPDIR/gridbase-bundle-smoke"
```

An offline build requires *all* selected runtime, JAR, archive and license/POM pins
in cache under their exact `filename` values in `scripts/engine-dependencies.json`.
No developer `build/deps`, `drivers`, `SPARK_HOME` or existing compiled classes are
used as release inputs. Every cache reuse hashes the actual bytes; corruption is
an actionable failure, not silently trusted or overwritten. Remove/reacquire only
the identified corrupt cache file deliberately. Online fetches permit only listed
official HTTPS hosts and credential-free URLs, HTTP 200, at most 5 redirects,
30-second inactivity and 15-minute overall limits, and per-pin byte bounds. A
random exclusive partial file is never accepted as a verified cache entry.

The official PyPI JSON for PySpark 3.5.6 supplies the pinned sdist URL/SHA256.
The entire verified sdist is validated before selecting **all 252** `deps/jars`
files, including Hive JDBC 2.3.9. Direct pins: Gson 2.13.2, JSqlParser 5.3, SQLite
JDBC 3.54.1.0, PostgreSQL JDBC 42.7.5, Connector/J 9.0.0, and its declared required
protobuf-java 4.26.1. Optional Connector/J OCI SDK/auth is not bundled or supported.
Gson/JSqlParser precede all Spark JARs in the enumerated classpath.

Temurin JRE pins intentionally differ: Linux 17.0.21.1+2 and Windows 17.0.21+9.
These are compatibility inputs, not a statement of latest/security-clean versions.
The exact official source tag license/notice files and Maven POMs are pinned too.
PySpark's sdist lacks root LICENSE/NOTICE and much of the binary notice set, so
both Spark source **and binary** LICENSE/NOTICE and the full official tagged
`licenses-binary/` collection are separately downloaded, hashed and retained.

## Fixed artifact contract

The directory supplied to `--out` is the later
`process.resourcesPath/gridbase-engine` bundle root. It contains:

```text
engine/manifest.json                 # exact reviewed schema 1 / protocol 1
engine/runtime/                      # complete platform JRE, release/legal/NOTICE
engine/app/classes/                  # direct javac --release 17 production classes
engine/app/resources/{VERSION,public/}
engine/drivers/                      # direct exact-version JDBC/support JARs
engine/drivers/spark/                # complete pinned PySpark 252-JAR closure
engine/licenses/                    # upstream notices, POMs, inventories, build inputs
engine/native/gridbase-launcher      # Linux fixed 0700 nonprivileged launcher
engine/native/win32-x64/             # Windows: exactly two reviewed production EXEs
```

No runtime fields/manifest policy changed. Every regular file except manifest
itself is SHA256-inventoried in portable, deterministic sorted order; the complete
runtime, resources, native helpers and notices are covered. No recursive checksum
self-reference. `licenses/dependencies.json` lists each included JAR digest/size,
source artifact and extracted-notice mapping. `production-sources.json` records
the explicit 32-source Java allowlist; test/helper/fixture classes are refused.
Public resources use an exact allowlist, not workspace-wide copying.

Build staging is private under `TMPDIR`; successful copying is rehashed and
manifest is published last. Failure does not leave a valid completed manifest.
Modes are normalized to owner-only 0700 directories/executable files or 0600 data;
mtimes normalize to epoch. Java classes are not a timestamp-bearing JAR. Same
inputs **and build toolchain** should yield identical file bytes/inventory. A
compiler/JDK change requires fresh reproducibility checks; cross-toolchain byte
identity is not claimed. Signing, if authorized later, must precede final hashing.

## Archive safety and trust boundary

Build-only `scripts/package-engine/extract.py` uses Python stdlib and never
`extractall`/shell extraction. Default bounds: 512 MiB compressed input, 12,000
entries, 192 MiB per file, 768 MiB total expanded (including dereferenced copies), bounded tar stream padding,
and 120-second helper command deadline. Reject absolute/drive/UNC/backslash paths,
traversal, reserved Windows names, control characters, case aliases, duplicate
entries, file ancestors, devices/FIFOs, hardlinks, unknown/special ZIP types,
encrypted ZIP entries and broken/truncated archives. Validate ELF64 x86-64 or PE32+
AMD64 *and* runtime release OS/architecture/Java17 metadata, not archive filenames.

Only Linux runtime `legal/` symlinks are allowed, after every destination is
validated as an internal known regular legal file, with escape/cycle/ancestor
checks; each becomes an independent single-link regular copy. No production
verifier link check was relaxed. Upstream Windows ZIP directories carry SGID build
metadata: directory modes are never copied; new directories are private 0700.
SUID/SGID regular files are rejected. No capabilities or extended attributes are
copied. Cache/build paths are trusted builder-owned locations; same-user malicious
concurrent tampering is not a sandbox boundary or a signed supply-chain guarantee.

## What the diagnostic proves, and what it does not

`smoke.js` copies a real bundle to a scratch read-only tree, invokes bundled
`java --version`, compiles a diagnostic probe **outside** the bundle with the build
JDK, and runs it with exact manifest classpath plus that external probe. It loads
all four real drivers and performs SQLite native extraction, CREATE/INSERT/SELECT
and metadata checks in private scratch. SQLite extraction is checked *while the
JVM is alive* because its cleanup removes temporary libraries at exit.

It calls ordinary `loadManifest` and public `EngineClient.start`, authenticates
health/local session, persists/reopens a synthetic profile and local owner,
observes the actual child's `/proc/.../exe` and only HOME/LANG/LC_ALL/TMPDIR env,
and verifies ordinary owned exit 0 plus an unchanged read-only inventory. Keys and
bootstrap material are memory-only and never logged. Separate private data/temp
remain writable; no writes land in runtime. A synthetic stored PostgreSQL profile
is **not a successful PostgreSQL connection**. SQLite probe query/metadata is not
a PostgreSQL/MySQL/Hive query/metadata result. No production database is touched.

Native Linux desktop GUI/GTK/keyring, Windows 11, installed filesystem behavior,
actual live PostgreSQL/MySQL/Hive services and supported credential paths remain
separate acceptance gates. Windows crosspack ELF-host compilation/PE hashes are
metadata evidence only; no Windows binaries are invoked and the public Windows
startup refusal is unchanged. The existing GUI E2E remains blocked/not run; its
skip must not be folded into the 49 existing Windows native skips.

## Licensing and Task7B handoff

Read `engine/licenses/THIRD_PARTY_NOTICES.md`, upstream runtime legal material,
Spark binary notices and the actual driver notices. MySQL is GPLv2 with additional
permission/Universal FOSS Exception, **not an unrestricted permissive driver**.
Redistribution eligibility, corresponding-source/source-offer arrangements,
JSqlParser's POM versus embedded LICENSE inconsistency, security review, and any
commercial-license need require release review; generated inventory is not legal
clearance. No Electron/Chromium/Forge artifacts are included in this engine-only
bundle; Task7B must add their complete notices separately.

Task7B assembles trusted `desktop/`, `public/`, `packages/local-engine/` siblings
under `app.getAppPath()` and this extraResources root. Forge/installers/CI,
signing/trust, Windows native build tooling/acceptance, OS prerequisites, native
installer/upgrade/uninstall/offline UI checks and real database integrations are
not delivered by Task7A. Do not weaken startup guards, sandbox, verifier, private
storage or key-provider policy to make those gates appear complete.
