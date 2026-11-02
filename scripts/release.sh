#!/bin/bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ENTITLEMENTS="$ROOT/scripts/sea-entitlements.plist"
readonly ASSET_NAME="momonga-darwin-arm64"
readonly CHECKSUMS_NAME="SHA256SUMS"
readonly OUT_DIR="$ROOT/dist/release"
readonly BINARY="$OUT_DIR/$ASSET_NAME"
readonly ARCHIVE="$OUT_DIR/$ASSET_NAME.zip"
readonly CHECKSUMS="$OUT_DIR/$CHECKSUMS_NAME"
readonly OTHER_TARGETS=(linux-x64 linux-arm64 win-x64)
readonly OTHER_ASSETS=(momonga-linux-x64 momonga-linux-arm64 momonga-win-x64.exe)

DRY_RUN="${DRY_RUN:-0}"

fail() {
  printf 'release.sh: %s\n' "$*" >&2
  exit 1
}

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY_RUN:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

step() {
  printf '== %s\n' "$*"
}

require_env() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || fail "$name is not set"
  done
}

verify_team_id() {
  if [ "$DRY_RUN" = "1" ]; then
    run codesign --display --verbose=4 "$BINARY"
    return
  fi
  local display
  display="$(codesign --display --verbose=4 "$BINARY" 2>&1)" || fail "codesign --display failed: $display"
  printf '%s\n' "$display" | grep -Fxq "TeamIdentifier=$MOMONGA_TEAM_ID" || fail "the signed binary does not carry TeamIdentifier=$MOMONGA_TEAM_ID"
}

write_checksums() {
  (cd "$OUT_DIR" && shasum -a 256 "$ASSET_NAME" "${OTHER_ASSETS[@]}" > "$CHECKSUMS_NAME")
}

case "$DRY_RUN" in
  0 | 1) ;;
  *) fail "DRY_RUN must be 0 or 1, got '$DRY_RUN'" ;;
esac

require_env SIGNING_IDENTITY APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER MOMONGA_REPO MOMONGA_TEAM_ID
[ -f "$APPLE_API_KEY" ] || fail "APPLE_API_KEY must be the path of the App Store Connect .p8 key file"
[[ "$MOMONGA_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || fail "MOMONGA_REPO must be <owner>/<repo>, got '$MOMONGA_REPO'"
[[ "$MOMONGA_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || fail "MOMONGA_TEAM_ID must be a 10-character Apple Team ID, got '$MOMONGA_TEAM_ID'"

readonly UPDATE_SOURCE_FLAGS=(--repo "$MOMONGA_REPO" --team-id "$MOMONGA_TEAM_ID")

cd "$ROOT"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean"

version="$(node --print "JSON.parse(require('node:fs').readFileSync('packages/cli/package.json', 'utf8')).version")"
[ -n "$version" ] || fail "packages/cli/package.json has no version"
tag="v$version"
git rev-parse --verify --quiet "refs/tags/$tag" > /dev/null && fail "tag $tag already exists"
commit="$(git rev-parse HEAD)"

previous_tag="$(git tag --list 'v*' --sort=-v:refname | head -n 1)"
if [ -n "$previous_tag" ]; then
  notes="$(git log --no-merges --pretty='- %s (%h)' "$previous_tag..HEAD")"
else
  notes="$(git log --no-merges --pretty='- %s (%h)' HEAD)"
fi
[ -n "$notes" ] || fail "no commits since $previous_tag"

step "build single executable"
run mkdir -p "$OUT_DIR"
run npm run sea -- --unsigned --output "$BINARY" "${UPDATE_SOURCE_FLAGS[@]}"

step "sign with Developer ID (hardened runtime, JIT entitlement)"
run codesign --sign "$SIGNING_IDENTITY" --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" "$BINARY"
run codesign --verify --strict --verbose=2 "$BINARY"
verify_team_id
run "$BINARY" --version

step "archive for notarization"
run rm -f "$ARCHIVE"
run ditto -c -k --keepParent "$BINARY" "$ARCHIVE"

step "notarize"
submission="$(run xcrun notarytool submit "$ARCHIVE" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait --output-format json)"
printf '%s\n' "$submission"
if [ "$DRY_RUN" = "0" ]; then
  printf '%s\n' "$submission" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"Accepted"' || fail "notarization was not accepted"
fi

step "assess with Gatekeeper"
run spctl --assess --type execute --verbose=4 "$BINARY"

step "build linux and windows executables"
for index in "${!OTHER_TARGETS[@]}"; do
  run npm run sea -- --unsigned --target "${OTHER_TARGETS[$index]}" --output "$OUT_DIR/${OTHER_ASSETS[$index]}" "${UPDATE_SOURCE_FLAGS[@]}"
done

step "checksums"
run write_checksums

step "publish $tag"
printf 'release notes:\n%s\n' "$notes"
run git tag --annotate "$tag" --message "$tag" "$commit"
run git push origin "refs/tags/$tag"
run gh release create "$tag" "$BINARY" "${OTHER_ASSETS[@]/#/$OUT_DIR/}" "$CHECKSUMS" --repo "$MOMONGA_REPO" --verify-tag --title "$tag" --notes "$notes"
