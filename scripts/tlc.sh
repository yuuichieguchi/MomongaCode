#!/usr/bin/env bash
set -euo pipefail

JAR_VERSION="TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)"
JAR_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
JAR_URL="https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
jar="$root/.cache/tla/tla2tools.jar"
spec_dir="$root/specs/tla"

usage() {
  echo "usage: scripts/tlc.sh <config-name> [extra TLC args]" >&2
  echo "  config-name: a file specs/tla/<config-name>.cfg, for example RunRecovery" >&2
  echo "  expected jar: $jar" >&2
  echo "  pinned sha256: $JAR_SHA256" >&2
  echo "  pinned version: $JAR_VERSION" >&2
  echo "  fetch: curl -L -o $jar $JAR_URL" >&2
}

if [ "$#" -lt 1 ]; then
  usage
  exit 2
fi

config="$1"
shift

if [ ! -f "$jar" ]; then
  echo "tla2tools.jar is missing" >&2
  usage
  exit 3
fi

actual="$(shasum -a 256 "$jar" | cut -d' ' -f1)"
if [ "$actual" != "$JAR_SHA256" ]; then
  echo "tla2tools.jar sha256 mismatch: expected $JAR_SHA256, got $actual" >&2
  exit 4
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

java -cp "$jar" tla2sany.SANY "$spec_dir/RunRecovery.tla"

java -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
  -workers auto \
  -metadir "$work" \
  -config "$spec_dir/$config.cfg" \
  "$@" \
  "$spec_dir/RunRecovery.tla"
