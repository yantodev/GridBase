#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPENDENCY_DIR="${1:-$PROJECT_ROOT/build/deps}"
SQLITE_VERSION=3.54.1.0
SQLITE_SHA256=f8dce420a6016278497f4f0560f65602b9db858de141b541cf91a4644ebe4639
SQLITE_JAR="$DEPENDENCY_DIR/sqlite-jdbc.jar"
mkdir -p "$DEPENDENCY_DIR"
if [[ ! -f "$SQLITE_JAR" ]] || ! echo "$SQLITE_SHA256  $SQLITE_JAR" | sha256sum --check --status; then
  SQLITE_DOWNLOAD="$(mktemp "$DEPENDENCY_DIR/sqlite-download.XXXXXX")"
  trap 'rm -f "$SQLITE_DOWNLOAD"' EXIT
  curl --fail --silent --show-error --location --retry 2 \
    "https://repo.maven.apache.org/maven2/org/xerial/sqlite-jdbc/$SQLITE_VERSION/sqlite-jdbc-$SQLITE_VERSION.jar" \
    --output "$SQLITE_DOWNLOAD"
  echo "$SQLITE_SHA256  $SQLITE_DOWNLOAD" | sha256sum --check --status
  mv "$SQLITE_DOWNLOAD" "$SQLITE_JAR"
fi
printf '%s\n' "$SQLITE_JAR"
