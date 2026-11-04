#!/bin/bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ENTITLEMENTS="$ROOT/scripts/sea-entitlements.plist"
readonly ASSET_NAME="momonga-darwin-arm64"
readonly CHECKSUMS_NAME="SHA256SUMS"
readonly SIGNATURE_NAME="SHA256SUMS.sig"
readonly SIGNATURE_NAMESPACE="momonga-release"
readonly OUT_DIR="$ROOT/dist/release"
readonly BINARY="$OUT_DIR/$ASSET_NAME"
readonly ARCHIVE="$OUT_DIR/$ASSET_NAME.zip"
readonly CHECKSUMS="$OUT_DIR/$CHECKSUMS_NAME"
readonly SIGNATURE="$OUT_DIR/$SIGNATURE_NAME"
readonly SIGNING_IDENTITY="Developer ID Application: Yuuichi Eguchi (PQQBSRKD72)"
readonly MOMONGA_TEAM_ID="PQQBSRKD72"
readonly RELEASE_SIGNING_KEY="$HOME/.ssh/momonga-release"
readonly OTHER_TARGETS=(linux-x64 linux-arm64 win-x64)
readonly OTHER_ASSETS=(momonga-linux-x64 momonga-linux-arm64 momonga-win-x64.exe)

DRY_RUN="${DRY_RUN:-0}"
readonly RELEASE_BRANCH="${MOMONGA_RELEASE_BRANCH:-main}"

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

assert_executable_format() {
  local file="$1" format="$2" magic
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY_RUN: check %s is a %s executable\n' "$file" "$format"
    return
  fi
  [ -s "$file" ] || fail "$file was not built"
  case "$format" in
    ELF) magic="$(head -c 4 "$file" | od -An -tx1 | tr -d ' \n')"; [ "$magic" = "7f454c46" ] || fail "$file is not an ELF executable" ;;
    PE) magic="$(head -c 2 "$file")"; [ "$magic" = "MZ" ] || fail "$file is not a PE executable" ;;
    *) fail "unknown executable format $format" ;;
  esac
}

assert_binary_version() {
  local built
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY_RUN: compare "%s --version" with %s\n' "$BINARY" "$version"
    return
  fi
  built="$("$BINARY" --version)" || fail "$BINARY --version failed"
  [ "$built" = "$version" ] || fail "the built binary reports version '$built', not $version"
}

delete_draft() {
  if [ "$draft_created" = "1" ]; then
    gh release delete "$tag" --yes --repo "$MOMONGA_REPO" || printf 'release.sh: could not delete the draft release %s; delete it before running again\n' "$tag" >&2
  fi
}

write_checksums() {
  (cd "$OUT_DIR" && shasum -a 256 "$ASSET_NAME" "${OTHER_ASSETS[@]}" > "$CHECKSUMS_NAME")
}

case "$DRY_RUN" in
  0 | 1) ;;
  *) fail "DRY_RUN must be 0 or 1, got '$DRY_RUN'" ;;
esac

require_env APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
[ -f "$RELEASE_SIGNING_KEY" ] || fail "the ssh private key that signs $CHECKSUMS_NAME must be at $RELEASE_SIGNING_KEY"
[ -f "$APPLE_API_KEY" ] || fail "APPLE_API_KEY must be the path of the App Store Connect .p8 key file"

readonly RELEASE_KEY_TOOL="$ROOT/scripts/release-key.ts"
MOMONGA_REPO="$(node "$RELEASE_KEY_TOOL" print-repo)" || fail "the installers do not embed a usable release repository; nothing was built"
readonly MOMONGA_REPO
[[ "$MOMONGA_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || fail "MOMONGA_REPO must be <owner>/<repo>, got '$MOMONGA_REPO'"
pinned_key="$(node "$RELEASE_KEY_TOOL" print)" || fail "the installers do not pin a usable release public key; nothing was built"
readonly pinned_key
readonly UPDATE_SOURCE_FLAGS=(--repo "$MOMONGA_REPO" --team-id "$MOMONGA_TEAM_ID" --release-public-key "$pinned_key")

cd "$ROOT"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean"

current_branch="$(git symbolic-ref --quiet --short HEAD)" || fail "HEAD is not on a branch; releases are cut from $RELEASE_BRANCH"
[ "$current_branch" = "$RELEASE_BRANCH" ] || fail "releases are cut from $RELEASE_BRANCH, not $current_branch"
git fetch --quiet origin "$RELEASE_BRANCH" || fail "could not fetch origin/$RELEASE_BRANCH"
commit="$(git rev-parse HEAD)"
[ "$commit" = "$(git rev-parse "refs/remotes/origin/$RELEASE_BRANCH")" ] || fail "HEAD is not origin/$RELEASE_BRANCH; push or pull so that the release lands on a published commit"

version="$(node --print "JSON.parse(require('node:fs').readFileSync('packages/cli/package.json', 'utf8')).version")"
[ -n "$version" ] || fail "packages/cli/package.json has no version"
tag="v$version"
git rev-parse --verify --quiet "refs/tags/$tag" > /dev/null && fail "tag $tag already exists"
if git ls-remote --exit-code --tags origin "refs/tags/$tag" > /dev/null 2>&1; then fail "tag $tag already exists on origin"; fi

previous_tag="$(git tag --list 'v*' --sort=-v:refname | head -n 1)"
if [ -n "$previous_tag" ]; then
  notes="$(git log --no-merges --pretty='- %s (%h)' "$previous_tag..HEAD")"
else
  notes="$(git log --no-merges --pretty='- %s (%h)' HEAD)"
fi
[ -n "$notes" ] || fail "no commits since $previous_tag"

draft_created=0
trap 'status=$?; if [ "$status" -ne 0 ]; then delete_draft; fi' EXIT

step "typecheck and every test project"
run npm run typecheck
run npm test
run npm run test:e2e
run npm run test:packaging

step "build single executable"
run mkdir -p "$OUT_DIR"
run npm run sea -- --unsigned --output "$BINARY" "${UPDATE_SOURCE_FLAGS[@]}"

step "sign with Developer ID (hardened runtime, JIT entitlement)"
run codesign --sign "$SIGNING_IDENTITY" --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" "$BINARY"
run codesign --verify --strict --verbose=2 "$BINARY"
verify_team_id
assert_binary_version

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
assert_executable_format "$OUT_DIR/momonga-linux-x64" ELF
assert_executable_format "$OUT_DIR/momonga-linux-arm64" ELF
assert_executable_format "$OUT_DIR/momonga-win-x64.exe" PE

step "checksums and their signature"
run write_checksums
run rm -f "$SIGNATURE"
run ssh-keygen -Y sign -f "$RELEASE_SIGNING_KEY" -n "$SIGNATURE_NAMESPACE" "$CHECKSUMS"
run node "$RELEASE_KEY_TOOL" verify "$CHECKSUMS" "$SIGNATURE"

step "publish $tag"
printf 'release notes:\n%s\n' "$notes"
draft_created=1
run gh release create "$tag" "$BINARY" "${OTHER_ASSETS[@]/#/$OUT_DIR/}" "$CHECKSUMS" "$SIGNATURE" --repo "$MOMONGA_REPO" --draft --target "$commit" --title "$tag" --notes "$notes"
run gh release edit "$tag" --repo "$MOMONGA_REPO" --draft=false
draft_created=0
run git fetch origin "refs/tags/$tag:refs/tags/$tag"
