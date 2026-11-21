#!/bin/bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ENTITLEMENTS="$ROOT/scripts/sea-entitlements.plist"
readonly ASSET_NAME="momonga-darwin-arm64"
readonly CHECKSUMS_NAME="SHA256SUMS"
readonly SIGNATURE_NAME="SHA256SUMS.sig"
readonly NOTICES_NAME="THIRD-PARTY-NOTICES.md"
readonly SIGNATURE_NAMESPACE="momonga-release"
readonly OUT_DIR="$ROOT/dist/release"
readonly BINARY="$OUT_DIR/$ASSET_NAME"
readonly ARCHIVE="$OUT_DIR/$ASSET_NAME.zip"
readonly CHECKSUMS="$OUT_DIR/$CHECKSUMS_NAME"
readonly SIGNATURE="$OUT_DIR/$SIGNATURE_NAME"
readonly NOTICES="$OUT_DIR/$NOTICES_NAME"
readonly SITE_DIR="$ROOT/dist/site"
readonly MOMONGA_TEAM_ID="PQQBSRKD72"
readonly SIGNING_IDENTITY="Developer ID Application: Yuuichi Eguchi ($MOMONGA_TEAM_ID)"
readonly RELEASE_SIGNING_KEY="$HOME/.ssh/momonga-release"
readonly OTHER_TARGETS=(linux-x64 linux-arm64 win-x64)
readonly OTHER_ASSETS=(momonga-linux-x64 momonga-linux-arm64 momonga-win-x64.exe)

DRY_RUN="${DRY_RUN:-0}"
SKIP_TEST_SUITE=0
SKIP_MACOS_SMOKE=0
SKIP_LINUX_SMOKE=0
NOTES_FILE_ARG=""
ERROR_LOG_ARG=""
binary_cdhash=""
readonly RELEASE_BRANCH="${MOMONGA_RELEASE_BRANCH:-main}"
readonly PUSH_BOUND_SECONDS=120
readonly FETCH_BOUND_SECONDS=120
readonly MAX_NOTES_CHARS="${MOMONGA_RELEASE_MAX_NOTES_CHARS:-100000}"

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

smoke_here() {
  run env MOMONGA_SEA_SMOKE_EXECUTABLE="$1" npx vitest run --project packaging scripts/sea-smoke.test.ts
}

smoke_in_linux_container() {
  local platform="$1" asset="$2" output
  if [ "$DRY_RUN" = "1" ]; then
    run docker run --rm -i --platform "$platform" node:24-bookworm bash -c "scripts/test-linux.sh" _ "MOMONGA_SEA_SMOKE_EXECUTABLE=dist/release/$asset node_modules/.bin/vitest run --project packaging scripts/sea-smoke.test.ts"
    return
  fi
  output="$(cd "$ROOT" && COPYFILE_DISABLE=1 tar --exclude=node_modules --exclude=.git --exclude=.claude -cf - . | docker run --rm -i --platform "$platform" --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined node:24-bookworm bash -c "$(cat "$ROOT/scripts/test-linux.sh")" _ "MOMONGA_SEA_SMOKE_EXECUTABLE=dist/release/$asset node_modules/.bin/vitest run --project packaging scripts/sea-smoke.test.ts")"
  printf '%s\n' "$output"
  [ "$(tail -n 1 <<< "$output")" = "EXIT=0" ] || fail "the smoke run of $asset in a $platform container did not end with EXIT=0"
}

require_docker() {
  if [ "$DRY_RUN" = "1" ]; then
    return
  fi
  command -v docker > /dev/null || fail "linux container smoke tests need docker on PATH (start Docker or pass --skip-linux-smoke / --skip-smoke); nothing was built"
  docker info > /dev/null 2>&1 || fail "docker daemon is not running; start Docker or pass --skip-linux-smoke / --skip-smoke; nothing was built"
}

verify_team_id() {
  if [ "$DRY_RUN" = "1" ]; then
    run codesign --display --verbose=4 "$BINARY"
    return
  fi
  local display
  display="$(codesign --display --verbose=4 "$BINARY" 2>&1)" || fail "codesign --display failed: $display"
  grep -Fxq "TeamIdentifier=$MOMONGA_TEAM_ID" <<< "$display" || fail "the signed binary does not carry TeamIdentifier=$MOMONGA_TEAM_ID"
  binary_cdhash="$(node -e '
    for (const line of require("node:fs").readFileSync(0, "utf8").split(/\r?\n/)) {
      if (line.startsWith("CDHash=")) {
        process.stdout.write(line.slice("CDHash=".length).trim());
        break;
      }
    }
  ' <<< "$display")"
  [ -n "$binary_cdhash" ] || fail "codesign --display did not report a CDHash for $BINARY"
}

verify_notarization_ticket() {
  if [ "$DRY_RUN" = "1" ]; then
    run xcrun notarytool log "<submission-id>" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
    return
  fi
  local submission_id notary_log status=0
  submission_id="$(node -e '
    const raw = require("node:fs").readFileSync(0, "utf8").trim();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = JSON.parse(raw.split("\n")[0]); }
    if (parsed && typeof parsed.id === "string" && parsed.id.length > 0) process.stdout.write(parsed.id);
  ' <<< "$submission")" || fail "notarization output did not report a submission id"
  [ -n "$submission_id" ] || fail "notarization output did not report a submission id"
  notary_log="$(run xcrun notarytool log "$submission_id" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")"
  node -e '
    const expected = process.argv[1].toLowerCase();
    const log = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (log.status !== "Accepted") process.exit(2);
    const contents = Array.isArray(log.ticketContents) ? log.ticketContents : [];
    const found = contents.some((entry) => typeof entry?.cdhash === "string" && entry.cdhash.toLowerCase() === expected);
    if (!found) process.exit(3);
  ' "$binary_cdhash" <<< "$notary_log" || status=$?
  case "$status" in
    0) ;;
    2) fail "notarization log status is not Accepted" ;;
    3) fail "notarization ticket does not include CDHash $binary_cdhash of $BINARY" ;;
    *) fail "notarization log could not be parsed" ;;
  esac
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

assert_embedded_ripgrep() {
  local file="$1" target="$2"
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY_RUN: ripgrep-manifest %s %s\n' "$file" "$target"
    return
  fi
  node "$ROOT/scripts/embedded-ripgrep.ts" check "$file" "$target" || fail "$file does not embed the ripgrep manifest of $target"
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
  (cd "$OUT_DIR" && shasum -a 256 "$ASSET_NAME" "${OTHER_ASSETS[@]}" "$NOTICES_NAME" > "$CHECKSUMS_NAME")
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-test-suite) SKIP_TEST_SUITE=1 ;;
    --skip-linux-smoke) SKIP_LINUX_SMOKE=1 ;;
    --skip-smoke)
      SKIP_MACOS_SMOKE=1
      SKIP_LINUX_SMOKE=1
      ;;
    --notes-file)
      [ "$#" -ge 2 ] || fail "--notes-file requires a path"
      NOTES_FILE_ARG="$2"
      shift
      ;;
    --error-log)
      [ "$#" -ge 2 ] || fail "--error-log requires a path"
      ERROR_LOG_ARG="$2"
      shift
      ;;
    *) fail "unknown option '$1' (supported: --skip-test-suite, --skip-linux-smoke, --skip-smoke, --notes-file <path>, --error-log <path>)" ;;
  esac
  shift
done
if [ -n "$NOTES_FILE_ARG" ]; then
  [ -f "$NOTES_FILE_ARG" ] || fail "notes file '$NOTES_FILE_ARG' does not exist"
  NOTES_FILE_ARG="$(cd "$(dirname "$NOTES_FILE_ARG")" && pwd)/$(basename "$NOTES_FILE_ARG")"
fi
if [ -n "$ERROR_LOG_ARG" ]; then
  ERROR_LOG_ARG="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$ERROR_LOG_ARG")"
fi
readonly SKIP_TEST_SUITE SKIP_MACOS_SMOKE SKIP_LINUX_SMOKE NOTES_FILE_ARG ERROR_LOG_ARG

case "$DRY_RUN" in
  0 | 1) ;;
  *) fail "DRY_RUN must be 0 or 1, got '$DRY_RUN'" ;;
esac

bash "$ROOT/scripts/release-tools.sh"
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
site_origin="$(node "$ROOT/scripts/site-target.ts" print-origin)" || fail "scripts/site-target.ts does not name the origin of the site; nothing was built"
readonly SITE_HOST="${site_origin#https://}"

cd "$ROOT"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean"

current_branch="$(git symbolic-ref --quiet --short HEAD)" || fail "HEAD is not on a branch; releases are cut from $RELEASE_BRANCH"
[ "$current_branch" = "$RELEASE_BRANCH" ] || fail "releases are cut from $RELEASE_BRANCH, not $current_branch"
node "$ROOT/scripts/site/bounded.ts" "$FETCH_BOUND_SECONDS" git fetch --quiet origin "$RELEASE_BRANCH" || fail "could not fetch origin/$RELEASE_BRANCH"
commit="$(git rev-parse HEAD)"
git merge-base --is-ancestor "refs/remotes/origin/$RELEASE_BRANCH" "$commit" || fail "$RELEASE_BRANCH of origin has commits that HEAD does not have; pull (or rebase) first, then run scripts/release.sh again; nothing was built"

version="$(node --print "JSON.parse(require('node:fs').readFileSync('packages/cli/package.json', 'utf8')).version")"
[ -n "$version" ] || fail "packages/cli/package.json has no version"
tag="v$version"
git rev-parse --verify --quiet "refs/tags/$tag" > /dev/null && fail "tag $tag already exists"
if git ls-remote --exit-code --tags origin "refs/tags/$tag" > /dev/null 2>&1; then fail "tag $tag already exists on origin"; fi

notes_file="$(mktemp "${TMPDIR:-/tmp}/momonga-release-notes.XXXXXX")"
draft_created=0
trap 'status=$?; rm -f "$notes_file"; if [ "$status" -ne 0 ]; then delete_draft; fi' EXIT

previous_tag="$(git for-each-ref --count=1 --sort=-v:refname --format='%(refname:short)' 'refs/tags/v*')"
if [ -n "$NOTES_FILE_ARG" ]; then
  node -e '
    const fs = require("node:fs");
    const [src, dst, maxRaw] = process.argv.slice(1);
    const max = Number(maxRaw);
    const body = fs.readFileSync(src, "utf8").trim();
    if (body.length === 0) process.exit(2);
    if (body.length > max) process.exit(3);
    fs.writeFileSync(dst, `${body}\n`);
  ' "$NOTES_FILE_ARG" "$notes_file" "$MAX_NOTES_CHARS" || {
    status=$?
    if [ "$status" -eq 2 ]; then fail "notes file '$NOTES_FILE_ARG' is empty"; fi
    if [ "$status" -eq 3 ]; then fail "notes file '$NOTES_FILE_ARG' exceeds $MAX_NOTES_CHARS characters"; fi
    fail "could not read notes file '$NOTES_FILE_ARG'"
  }
elif [ -n "$previous_tag" ]; then
  git log --no-merges --pretty='- %s (%h)' "$previous_tag..HEAD" | node -e '
    const fs = require("node:fs");
    const [dst, maxRaw] = process.argv.slice(1);
    const max = Number(maxRaw);
    const raw = fs.readFileSync(0, "utf8").trim();
    if (raw.length === 0) process.exit(2);
    if (raw.length <= max) {
      fs.writeFileSync(dst, `${raw}\n`);
      process.exit(0);
    }
    const lines = raw.split("\n");
    const kept = [];
    let used = 0;
    for (let i = 0; i < lines.length; i++) {
      const remaining = lines.length - i;
      const suffix = `\n- ...and ${remaining} more commits`;
      const piece = (kept.length === 0 ? "" : "\n") + lines[i];
      if (used + piece.length + suffix.length > max) break;
      kept.push(lines[i]);
      used += piece.length;
    }
    const omitted = lines.length - kept.length;
    const suffix = `- ...and ${omitted} more commits`;
    const body = kept.length > 0 ? `${kept.join("\n")}\n${suffix}` : suffix;
    fs.writeFileSync(dst, `${body}\n`);
  ' "$notes_file" "$MAX_NOTES_CHARS" || {
    status=$?
    if [ "$status" -eq 2 ]; then fail "no commits since $previous_tag"; fi
    fail "could not prepare release notes"
  }
else
  printf 'Initial release %s.\n' "$tag" > "$notes_file"
fi

if [ "$SKIP_LINUX_SMOKE" = "0" ]; then
  require_docker
fi

if [ "$SKIP_TEST_SUITE" = "1" ]; then
  step "typecheck (test suite skipped by --skip-test-suite)"
  run npm run typecheck
else
  step "typecheck and every test project"
  run npm run typecheck
  if [ -n "$ERROR_LOG_ARG" ]; then
    run env MOMONGA_TEST_ERROR_LOG="$ERROR_LOG_ARG" npm test
  else
    run npm test
  fi
fi

step "build single executable"
run mkdir -p "$OUT_DIR"
run npm run sea -- --unsigned --output "$BINARY" "${UPDATE_SOURCE_FLAGS[@]}"
assert_embedded_ripgrep "$BINARY" darwin-arm64

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
  grep -Eq '"status"[[:space:]]*:[[:space:]]*"Accepted"' <<< "$submission" || fail "notarization was not accepted"
fi

step "verify notarization ticket"
verify_notarization_ticket

if [ "$SKIP_MACOS_SMOKE" = "1" ]; then
  step "macOS smoke skipped by --skip-smoke"
else
  step "start the signed macOS executable on this host"
  smoke_here "$BINARY"
fi

step "build linux and windows executables"
for index in "${!OTHER_TARGETS[@]}"; do
  run npm run sea -- --unsigned --target "${OTHER_TARGETS[$index]}" --output "$OUT_DIR/${OTHER_ASSETS[$index]}" "${UPDATE_SOURCE_FLAGS[@]}"
done
assert_executable_format "$OUT_DIR/momonga-linux-x64" ELF
assert_executable_format "$OUT_DIR/momonga-linux-arm64" ELF
assert_executable_format "$OUT_DIR/momonga-win-x64.exe" PE
for index in "${!OTHER_TARGETS[@]}"; do
  assert_embedded_ripgrep "$OUT_DIR/${OTHER_ASSETS[$index]}" "${OTHER_TARGETS[$index]}"
done

if [ "$SKIP_LINUX_SMOKE" = "1" ]; then
  step "linux container smoke skipped"
else
  step "start each linux executable in a container of its platform"
  smoke_in_linux_container linux/amd64 momonga-linux-x64
  smoke_in_linux_container linux/arm64 momonga-linux-arm64
fi

step "third-party notices of the release"
run npm run notices -- --output "$NOTICES"

step "build the site"
run node "$ROOT/scripts/site.ts" --output "$SITE_DIR"

step "checksums and their signature"
run write_checksums
run rm -f "$SIGNATURE"
run ssh-keygen -Y sign -f "$RELEASE_SIGNING_KEY" -n "$SIGNATURE_NAMESPACE" "$CHECKSUMS"
run node "$RELEASE_KEY_TOOL" verify "$CHECKSUMS" "$SIGNATURE"

step "push $RELEASE_BRANCH to origin"
run node "$ROOT/scripts/site/bounded.ts" "$PUSH_BOUND_SECONDS" git push --quiet origin "refs/heads/$RELEASE_BRANCH:refs/heads/$RELEASE_BRANCH" \
  || fail "$RELEASE_BRANCH could not be pushed to origin; check that origin is reachable and that its $RELEASE_BRANCH is not ahead of or diverged from HEAD, then run scripts/release.sh again; nothing was published"

step "publish $tag"
printf 'release notes:\n'
cat "$notes_file"
draft_created=1
run gh release create "$tag" "$BINARY" "${OTHER_ASSETS[@]/#/$OUT_DIR/}" "$NOTICES" "$CHECKSUMS" "$SIGNATURE" --repo "$MOMONGA_REPO" --draft --target "$commit" --title "$tag" --notes-file "$notes_file"
run gh release edit "$tag" --repo "$MOMONGA_REPO" --draft=false
draft_created=0
run git fetch origin "refs/tags/$tag:refs/tags/$tag"

step "update $SITE_HOST"
run bash "$ROOT/scripts/site-deploy.sh" || fail "the release $tag is published but $SITE_HOST was not updated: run scripts/site-deploy.sh again"
