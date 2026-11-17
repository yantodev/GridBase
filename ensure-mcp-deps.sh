#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPENDENCY_DIR="${1:-$PROJECT_ROOT/build/deps}"
mkdir -p "$DEPENDENCY_DIR"
fetch() {
  local name="$1" url="$2" digest="$3" target="$DEPENDENCY_DIR/$1.jar"
  if [[ ! -f "$target" ]] || ! printf '%s  %s\n' "$digest" "$target" | sha256sum --check --status; then
    local download
    download="$(mktemp "$DEPENDENCY_DIR/$name-download.XXXXXX")"
    if ! curl --fail --silent --show-error --location --retry 2 "$url" --output "$download" \
      || ! printf '%s  %s\n' "$digest" "$download" | sha256sum --check --status; then
      rm -f "$download"
      return 1
    fi
    mv "$download" "$target"
  fi
}
fetch gson https://repo.maven.apache.org/maven2/com/google/code/gson/gson/2.13.2/gson-2.13.2.jar dd0ce1b55a3ed2080cb70f9c655850cda86c206862310009dcb5e5c95265a5e0
fetch jsqlparser https://repo.maven.apache.org/maven2/com/github/jsqlparser/jsqlparser/5.3/jsqlparser-5.3.jar 41bcb5b00488231db179cb5a375690830a59aba521dfa303daa94dcb9dcc8e88
printf '%s:%s\n' "$DEPENDENCY_DIR/gson.jar" "$DEPENDENCY_DIR/jsqlparser.jar"
