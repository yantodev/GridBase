#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$PROJECT_ROOT/build/java"
SPARK_ROOT="${SPARK_HOME:-/home/buana/.local/opt/spark-3.5.6-bin-hadoop3}"
JDBC_DRIVER_DIR="${JDBC_DRIVER_DIR:-$PROJECT_ROOT/drivers}"
SQLITE_JAR="$(bash "$PROJECT_ROOT/ensure-sqlite-driver.sh")"

if [[ ! -d "$SPARK_ROOT/jars" ]]; then
  echo "Spark jars tidak ditemukan: $SPARK_ROOT/jars" >&2
  echo "Set SPARK_HOME ke instalasi Spark yang berisi hive-jdbc-2.3.9.jar." >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"
mapfile -d '' JAVA_SOURCES < <(find "$PROJECT_ROOT/java-service/src" -type f -name '*.java' -print0)
javac --add-modules jdk.httpserver -d "$BUILD_DIR" "${JAVA_SOURCES[@]}"

exec java --add-modules jdk.httpserver \
  -cp "$BUILD_DIR:$SQLITE_JAR:$SPARK_ROOT/jars/*:$JDBC_DRIVER_DIR/*" \
  com.peentar.thriftquery.ThriftQueryServer "$@"

