#!/bin/bash
set -euo pipefail

readonly ASSET_NAME="momonga-darwin-arm64"
readonly CHECKSUMS_NAME="SHA256SUMS"

fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "unsupported OS $(uname -s): only macOS is supported"
[ "$(uname -m)" = "arm64" ] || fail "unsupported architecture $(uname -m): only Apple silicon (arm64) is supported"

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

actual="$(shasum -a 256 "$staging/$ASSET_NAME" | awk '{ print $1 }')"
if [ "$actual" != "$expected" ]; then
  fail "sha256 mismatch for $ASSET_NAME: expected $expected, got $actual; nothing was installed"
fi

chmod 755 "$staging/$ASSET_NAME"
mv -f "$staging/$ASSET_NAME" "$target"
printf 'installed momonga to %s\n' "$target"
