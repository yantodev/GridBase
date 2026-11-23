# GridBase shared-engine third-party materials

This engine bundle is a build artifact, not an installer or a legal clearance.
`dependencies.json` records the exact official source URLs, versions, downloaded
archive digests, and every included JDBC/transitive JAR digest. `manifest.json`
adds the full regular-file inventory, including runtime libraries and all notices.
No dependency downloads are performed by the deployed engine host.

## Included components

- Eclipse Temurin Java 17 JRE: GPLv2 with Classpath Exception and component-specific
  terms. Retain the complete `engine/runtime/legal/` tree, `NOTICE`, and release
  metadata. Safe internal legal-file symlinks were copied to independent files;
  no upstream notice bytes were dropped. See the pinned Adoptium source release
  and the source repository/build identifiers in `runtime/release`.
- Apache Spark / PySpark 3.5.6, including Hive JDBC 2.3.9: all 252 unmodified JARs
  from the digest-verified official PyPI sdist, not a guessed JDBC subset.
  `spark-3.5.6-LICENSE`, `spark-3.5.6-NOTICE`, their `-binary` counterparts,
  every official `spark-3.5.6-licenses-binary-*` file, and `spark-upstream/`
  retain the tagged source/binary notices and all sdist `deps/licenses` files. The sdist
  itself omits the root LICENSE/NOTICE, hence the separately pinned official tag
  files. Every JAR's embedded license/notice/copyright files are retained under
  `jars/<jar-name>/`; `entries.json` maps original names to independent copies.
  Some upstream JARs contain no embedded notices; this is recorded, not invented
  or silently labeled Apache-only. The Spark license contains third-party terms.
- Gson 2.13.2: Apache-2.0; `Apache-2.0.txt` from the official Gson release tag.
- JSqlParser 5.3: upstream POM offers LGPL v2.1 or Apache-2.0; retain the actual
  upstream JAR LICENSE (which contains GPL text) and POM without rewriting them.
  Distribution licensing should be reviewed against the official source before
  release; the inventory is not a resolution of that upstream inconsistency.
- Xerial SQLite JDBC 3.54.1.0: Apache-2.0 plus its retained Zentus BSD notice;
  native components and the SQLite code are included inside the unmodified JAR.
- PostgreSQL JDBC 42.7.5: BSD-2-Clause plus embedded shaded SCRAM/stringprep
  notices, all retained in its JAR and independent notice copies.
- MySQL Connector/J 9.0.0 Community: GPLv2 with the additional linking permission
  and Universal FOSS Exception 1.0 described in `mysql-9.0.0-LICENSE`. That file
  also includes the upstream third-party licensing manual. This is NOT a blanket
  permission to redistribute any proprietary combination: review exception
  eligibility, corresponding-source/source-offer obligations and alternative
  commercial licensing before public distribution. No public release clearance
  is claimed. The pinned POM records the required protobuf dependency and the
  optional Oracle OCI dependency; optional OCI cloud authentication is not bundled
  or claimed supported.
- Protocol Buffers Java 4.26.1: the exact nonoptional dependency declared by
  Connector/J 9.0.0, BSD-3-Clause; `protobuf-4.26.1-LICENSE` retains its official
  tag license. The tested classic MySQL JDBC load is not proof of X Protocol or
  optional OCI operation.

Pinned official Maven POMs accompany the direct-driver license metadata. Nested
JARs are unmodified, retaining any other embedded documentation and notices.
Spark/Hive and JRE pins are compatibility choices, not claims of latest or
vulnerability-free dependencies. A release needs dependency/security/license
review, corresponding source arrangements where applicable, and real database
integration tests.

## Not in this engine artifact

Electron/Chromium, Playwright, Forge, installers and their transitive notices are
not included here. Task7B must inventory and supply those for the actual desktop
package. GridBase's native launcher/helpers are built from the reviewed checkout;
Windows crossbuilds are unsigned metadata-only artifacts on Linux. Windows public
engine startup remains disabled pending native acceptance. Do not infer OS,
keyring, GUI, installer, or live PostgreSQL/MySQL/Hive acceptance from this bundle.
