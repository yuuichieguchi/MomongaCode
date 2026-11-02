#!/bin/bash
set -euo pipefail

readonly CHECKSUMS_NAME="SHA256SUMS"

fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

os="$(uname -s)"
machine="$(uname -m)"
case "$os/$machine" in
  Darwin/arm64) ASSET_NAME="momonga-darwin-arm64" ;;
  Linux/x86_64) ASSET_NAME="momonga-linux-x64" ;;
  Linux/aarch64 | Linux/arm64) ASSET_NAME="momonga-linux-arm64" ;;
  Darwin/*) fail "unsupported architecture $machine: only Apple silicon (arm64) is supported on macOS" ;;
  Linux/*) fail "unsupported architecture $machine: only x86_64 and aarch64 are supported on Linux" ;;
  *) fail "unsupported OS $os: only macOS and Linux are supported; use install.ps1 on Windows" ;;
esac
readonly ASSET_NAME

prefix="${MOMONGA_INSTALL_PREFIX:-$HOME/.local}"

if [ -n "${MOMONGA_RELEASE_BASE_URL:-}" ]; then
  base_url="$MOMONGA_RELEASE_BASE_URL"
else
  [ -n "${MOMONGA_REPO:-}" ] || fail "set MOMONGA_REPO=<owner>/<repo> or MOMONGA_RELEASE_BASE_URL"
  if [ -n "${MOMONGA_VERSION:-}" ]; then
    base_url="https://github.com/$MOMONGA_REPO/releases/download/v$MOMONGA_VERSION"
  else
    base_url="https://github.com/$MOMONGA_REPO/releases/latest/download"
  fi
fi

bin_dir="$prefix/bin"
target="$bin_dir/momonga"

mkdir -p "$bin_dir"
staging="$(mktemp -d "$bin_dir/.momonga-install.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

fetch() {
  curl --fail --silent --show-error --location --proto-redir '=https' --output "$2" "$1"
}

fetch "$base_url/$CHECKSUMS_NAME" "$staging/$CHECKSUMS_NAME"
fetch "$base_url/$ASSET_NAME" "$staging/$ASSET_NAME"

expected="$(awk -v asset="$ASSET_NAME" '$2 == asset { print $1 }' "$staging/$CHECKSUMS_NAME")"
case "$expected" in
  *[!0-9a-f]* | "") fail "$CHECKSUMS_NAME has no valid entry for $ASSET_NAME" ;;
esac
[ "${#expected}" -eq 64 ] || fail "$CHECKSUMS_NAME has no valid entry for $ASSET_NAME"

if command -v sha256sum > /dev/null; then
  actual="$(sha256sum "$staging/$ASSET_NAME" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$staging/$ASSET_NAME" | awk '{ print $1 }')"
fi
if [ "$actual" != "$expected" ]; then
  fail "sha256 mismatch for $ASSET_NAME: expected $expected, got $actual; nothing was installed"
fi

chmod 755 "$staging/$ASSET_NAME"
mv -f "$staging/$ASSET_NAME" "$target"
printf 'installed momonga to %s\n' "$target"
