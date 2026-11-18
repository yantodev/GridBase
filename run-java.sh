#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"
JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
SPARK_ROOT="${SPARK_HOME:-/home/buana/.local/opt/spark-3.5.6-bin-hadoop3}"
JDBC_DRIVER_DIR="${JDBC_DRIVER_DIR:-$PROJECT_ROOT/drivers}"
SQLITE_JAR="$(bash "$PROJECT_ROOT/ensure-sqlite-driver.sh")"
MCP_DEPS="$(bash "$PROJECT_ROOT/ensure-mcp-deps.sh")"

if [[ ! -d "$SPARK_ROOT/jars" ]]; then
  echo "Spark jars tidak ditemukan: $SPARK_ROOT/jars" >&2
  echo "Set SPARK_HOME ke instalasi Spark yang berisi hive-jdbc-2.3.9.jar." >&2
  exit 1
fi

# A JVM loads classes lazily: never compile into a running process's classpath.
# Checks are disposable; runtime directories stay immutable until explicitly
# removed while their service is stopped.
if [[ "${1:-}" == "--check" ]]; then
  BUILD_DIR="$(mktemp -d "${TMPDIR:-$PROJECT_ROOT/build}/gridbase-java-check.XXXXXX")"
else
  mkdir -p "$PROJECT_ROOT/build/java-runs"
  BUILD_DIR="$(mktemp -d "$PROJECT_ROOT/build/java-runs/run.XXXXXX")"
fi
trap 'rm -rf -- "$BUILD_DIR"' EXIT
mapfile -d '' JAVA_SOURCES < <(find "$PROJECT_ROOT/java-service/src" -type f -name '*.java' -print0)
"$JAVAC" --release 17 --add-modules jdk.httpserver -cp "$MCP_DEPS" -d "$BUILD_DIR" "${JAVA_SOURCES[@]}"

JAVA_ARGS=(--add-modules jdk.httpserver
  -cp "$BUILD_DIR:$MCP_DEPS:$SQLITE_JAR:$SPARK_ROOT/jars/*:$JDBC_DRIVER_DIR/*"
  com.peentar.thriftquery.ThriftQueryServer "$@")
if [[ "${1:-}" == "--check" ]]; then
  "$JAVA" "${JAVA_ARGS[@]}"
else
  trap - EXIT
  exec "$JAVA" "${JAVA_ARGS[@]}"
fi

