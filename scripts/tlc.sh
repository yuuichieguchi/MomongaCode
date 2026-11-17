#!/usr/bin/env bash
set -euo pipefail

JAR_VERSION="TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)"
JAR_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
JAR_RELEASE_TAG="v1.7.4"
JAR_URL="${TLC_JAR_URL:-https://github.com/tlaplus/tlaplus/releases/download/$JAR_RELEASE_TAG/tla2tools.jar}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
jar="$root/.cache/tla/tla2tools.jar"
spec_dir="$root/specs/tla"

usage() {
  echo "usage: scripts/tlc.sh <config-name> [extra TLC args, for example -workers 4]" >&2
  echo "  config-name: a file specs/tla/<config-name>.cfg, for example RunRecovery;" >&2
  echo "  the module is the part of the name before the first dot: RunRecovery.children checks RunRecovery.tla" >&2
  echo "  TLC_METADIR: the state directory; when set, the caller owns it and the script does not remove it" >&2
  echo "  TLC_BUDGET_CPU_SECONDS: the CPU budget of a run with more than one worker, which holds the heavy run lock;" >&2
  echo "    when unset, the budgetCpuSeconds of the config's row in specs/tla/manifest.json; a config with no row needs it" >&2
  echo "  expected jar: $jar" >&2
  echo "  pinned sha256: $JAR_SHA256" >&2
  echo "  pinned version: $JAR_VERSION" >&2
  echo "  fetch: curl -L -o $jar $JAR_URL" >&2
  echo "  scripts/tlc.sh --fetch-jar downloads the jar and checks the pinned sha256" >&2
}

sha256_of() {
  if command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

fetch_jar() {
  mkdir -p "$(dirname "$jar")"
  partial="$(mktemp "$jar.XXXXXX")"
  trap 'rm -f "$partial"' EXIT
  curl --fail --silent --show-error --location --output "$partial" "$JAR_URL"
  fetched="$(sha256_of "$partial")"
  if [ "$fetched" != "$JAR_SHA256" ]; then
    echo "tla2tools.jar sha256 mismatch: expected $JAR_SHA256, got $fetched" >&2
    exit 4
  fi
  mv -f "$partial" "$jar"
}

if [ "$#" -lt 1 ]; then
  usage
  exit 2
fi

if [ "$1" = "--fetch-jar" ]; then
  fetch_jar
  exit 0
fi

config="$1"
shift

workers=1
previous=""
for argument in "$@"; do
  if [ "$previous" = "-workers" ]; then workers="$argument"; fi
  previous="$argument"
done
heavy=0
case "$workers" in
  0 | 1) ;;
  *) heavy=1 ;;
esac
if [ "$heavy" = 1 ] && [ -f "$root/scripts/run-lock.ts" ]; then
  case "${MOMONGA_RUN_LOCK:-}" in
    heavy.????????????????) ;;
    light.????????????????)
      echo "run-lock: a heavy run cannot start inside a light run: this tlc.sh call uses more than one worker" >&2
      exit 71 ;;
    *)
      if ! command -v node > /dev/null 2>&1; then
        echo "run-lock: node is required to take the run lock for a TLC run with more than one worker" >&2
        exit 73
      fi
      budget="${TLC_BUDGET_CPU_SECONDS:-}"
      if [ -z "$budget" ]; then budget="$(node "$root/scripts/support/run-budgets.ts" "$config")"; fi
      if [ -z "$budget" ]; then
        echo "run-lock: $config has no row in specs/tla/manifest.json, so it has no CPU budget: set TLC_BUDGET_CPU_SECONDS" >&2
        exit 64
      fi
      exec node "$root/scripts/run-lock.ts" heavy --budget-cpu-seconds "$budget" -- bash "${BASH_SOURCE[0]}" "$config" "$@" ;;
  esac
fi

java_properties="$(java -XshowSettings:properties -version 2>&1 || true)"
java_specification="$(awk -F' = ' '/java\.specification\.version/ && !found { print $2; found = 1 }' <<< "$java_properties")"
java_major="${java_specification#1.}"
java_major="${java_major%%.*}"
case "$java_major" in
  '' | *[!0-9]*) java_major=0 ;;
esac
if [ "$java_major" -lt 8 ]; then
  echo "java.specification.version 1.8 or later is required (found: ${java_specification:-no java})" >&2
  echo "  install a JDK on macOS, or openjdk-17-jre-headless on Debian" >&2
  exit 5
fi

if [ ! -f "$jar" ]; then
  echo "tla2tools.jar is missing" >&2
  usage
  exit 3
fi

actual="$(sha256_of "$jar")"
if [ "$actual" != "$JAR_SHA256" ]; then
  echo "tla2tools.jar sha256 mismatch: expected $JAR_SHA256, got $actual" >&2
  exit 4
fi

module="${config%%.*}"
module_file="$spec_dir/$module.tla"

if [ -n "${TLC_METADIR:-}" ]; then
  work="$TLC_METADIR"
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
fi

java_tmp="$work/java-tmp"
mkdir -p "$java_tmp"

java -Djava.io.tmpdir="$java_tmp" -cp "$jar" tla2sany.SANY "$module_file"

java -Djava.io.tmpdir="$java_tmp" -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
  -metadir "$work" \
  -config "$spec_dir/$config.cfg" \
  "$@" \
  "$module_file"
