# syntax=docker/dockerfile:1.7

FROM apache/spark:3.5.6 AS spark

FROM eclipse-temurin:17-jre-jammy AS jdbc-drivers

ARG POSTGRESQL_JDBC_VERSION=42.7.5
ARG MYSQL_JDBC_VERSION=9.0.0
COPY ensure-sqlite-driver.sh /tmp/ensure-sqlite-driver.sh
COPY ensure-mcp-deps.sh /tmp/ensure-mcp-deps.sh

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates curl \
    && mkdir -p /out \
    && bash /tmp/ensure-sqlite-driver.sh /out > /dev/null \
    && bash /tmp/ensure-mcp-deps.sh /out > /dev/null \
    && curl --fail --silent --show-error --location "https://repo1.maven.org/maven2/org/postgresql/postgresql/${POSTGRESQL_JDBC_VERSION}/postgresql-${POSTGRESQL_JDBC_VERSION}.jar" --output /out/postgresql.jar \
    && curl --fail --silent --show-error --location "https://repo1.maven.org/maven2/com/mysql/mysql-connector-j/${MYSQL_JDBC_VERSION}/mysql-connector-j-${MYSQL_JDBC_VERSION}.jar" --output /out/mysql-connector-j.jar \
    && rm -rf /var/lib/apt/lists/*

FROM eclipse-temurin:17-jdk-jammy AS build

WORKDIR /src

COPY --from=spark /opt/spark/jars/ /opt/spark/jars/

COPY java-service/src /src/java-service/src
COPY --from=jdbc-drivers /out/gson.jar /out/jsqlparser.jar /deps/

RUN mkdir -p /out/java \
    && find /src/java-service/src -type f -name '*.java' -print0 \
        | xargs -0 javac --release 17 --add-modules jdk.httpserver -cp '/deps/*' -d /out/java

FROM eclipse-temurin:17-jre-jammy AS runtime

ENV HOST=0.0.0.0 \
    PORT=4173 \
    QUERY_TIMEOUT_MS=30000 \
    DEFAULT_QUERY_LIMIT=50 \
    SPARK_HOME=/opt/spark \
    PATH=/opt/spark/bin:/opt/spark/sbin:$PATH \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 thriftquery \
    && useradd --system --uid 10001 --gid thriftquery --create-home --home-dir /app thriftquery \
    && mkdir -p /app/build/java /app/data /opt/spark/work-dir \
    && chown -R thriftquery:thriftquery /app

WORKDIR /app

COPY --from=build --chown=thriftquery:thriftquery /out/java /app/build/java
COPY --from=spark /opt/spark /opt/spark
COPY --from=jdbc-drivers --chown=thriftquery:thriftquery /out /opt/gridbase/drivers
COPY --chown=thriftquery:thriftquery public /app/public

RUN chown -R thriftquery:thriftquery /opt/spark/work-dir

USER thriftquery

EXPOSE 4173
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:4173/healthz > /dev/null || exit 1

ENTRYPOINT ["java", "--add-modules", "jdk.httpserver", "-cp", "/app/build/java:/opt/gridbase/drivers/*:/opt/spark/jars/*", "com.peentar.thriftquery.ThriftQueryServer"]
