#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$PROJECT_ROOT/build/java-tests"
SPARK_ROOT="${SPARK_HOME:-/home/buana/.local/opt/spark-3.5.6-bin-hadoop3}"
if [[ ! -f "$SPARK_ROOT/jars/hive-jdbc-2.3.9.jar" ]]; then
  echo "Hive JDBC driver tidak ditemukan di $SPARK_ROOT/jars" >&2
  exit 1
fi
mkdir -p "$BUILD_DIR"
mapfile -d '' JAVA_SOURCES < <(find "$PROJECT_ROOT/java-service/src" -type f -name '*.java' -print0)
javac --add-modules jdk.httpserver -d "$BUILD_DIR" "${JAVA_SOURCES[@]}"

java -ea --add-modules jdk.httpserver -cp "$BUILD_DIR" com.peentar.thriftquery.SqlPolicyTest
java -ea --add-modules jdk.httpserver -cp "$BUILD_DIR" com.peentar.thriftquery.JsonUtilTest
java -ea --add-modules jdk.httpserver -cp "$BUILD_DIR" com.peentar.thriftquery.AppConfigTest
java -ea --add-modules jdk.httpserver -cp "$BUILD_DIR" com.peentar.thriftquery.JdbcServiceTest
java -ea --add-modules jdk.httpserver -cp "$BUILD_DIR" com.peentar.thriftquery.JdbcMetadataTest
java --add-modules jdk.httpserver -cp "$BUILD_DIR:$SPARK_ROOT/jars/*" com.peentar.thriftquery.JdbcDriverTest

