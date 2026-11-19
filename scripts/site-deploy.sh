#!/bin/bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SITE_DIR="$ROOT/dist/site"
readonly RELEASE_BRANCH="${MOMONGA_RELEASE_BRANCH:-main}"
readonly SITE_TOOLS=(git node curl cmp)
readonly MAIN_FETCH_BOUND_SECONDS=120
readonly PUSH_BOUND_SECONDS=120
readonly FETCH_BOUND_SECONDS=30
readonly SERVED_TRIES=60
readonly SERVED_PAUSE_SECONDS=10

fail() {
  printf 'site-deploy.sh: %s\n' "$*" >&2
  exit 1
}

step() {
  printf '== %s\n' "$*"
}

missing=()
for tool in "${SITE_TOOLS[@]}"; do
  command -v "$tool" > /dev/null || missing+=("$tool")
done
[ "${#missing[@]}" -eq 0 ] || fail "deploying the site needs ${missing[*]} on PATH, not found; nothing was deployed"

cd "$ROOT"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean; commit or remove the changes; nothing was deployed"
[ "$(git rev-parse --is-shallow-repository)" = false ] || fail "this clone is shallow; deploying the site needs a full clone of the repository (git fetch --unshallow); nothing was deployed"
node "$ROOT/scripts/site/bounded.ts" "$MAIN_FETCH_BOUND_SECONDS" git fetch --quiet --no-tags origin "+refs/heads/$RELEASE_BRANCH:refs/remotes/origin/$RELEASE_BRANCH" \
  || fail "$RELEASE_BRANCH could not be fetched from origin; check that origin is reachable, then run scripts/site-deploy.sh again; nothing was deployed"
published="$(git rev-parse --verify --quiet "refs/remotes/origin/$RELEASE_BRANCH^{commit}")" || fail "$RELEASE_BRANCH of origin names no commit; nothing was deployed"
commit="$(git rev-parse HEAD)"
if ! git merge-base --is-ancestor "$commit" "$published"; then
  [ "$(git symbolic-ref --quiet HEAD || true)" = "refs/heads/$RELEASE_BRANCH" ] \
    || fail "HEAD is not a commit of $RELEASE_BRANCH on origin and $RELEASE_BRANCH is not checked out; check out $RELEASE_BRANCH, or a commit origin has on $RELEASE_BRANCH, then run scripts/site-deploy.sh again; nothing was deployed"
  git merge-base --is-ancestor "$published" "$commit" \
    || fail "$RELEASE_BRANCH of origin has commits that HEAD does not have; pull (or rebase) first, then run scripts/site-deploy.sh again; nothing was deployed"
  step "push $RELEASE_BRANCH to origin"
  node "$ROOT/scripts/site/bounded.ts" "$PUSH_BOUND_SECONDS" git push --quiet origin "refs/heads/$RELEASE_BRANCH:refs/heads/$RELEASE_BRANCH" \
    || fail "$RELEASE_BRANCH could not be pushed to origin; check that origin is reachable and that its $RELEASE_BRANCH is not ahead of or diverged from HEAD, then run scripts/site-deploy.sh again; nothing was deployed"
fi

origin="$(node "$ROOT/scripts/site-target.ts" print-origin)"
branch="$(node "$ROOT/scripts/site-target.ts" print-branch)"
content_type="$(node "$ROOT/scripts/site-target.ts" print-installer-content-type)"
listing="$(node "$ROOT/scripts/site-target.ts" print-installers)"
installers=()
while IFS= read -r file; do
  installers+=("$file")
done <<< "$listing"

step "build the site of $commit"
node "$ROOT/scripts/site.ts" --output "$SITE_DIR"

step "move the branch $branch of origin to $commit"
node "$ROOT/scripts/site/bounded.ts" "$PUSH_BOUND_SECONDS" git push --quiet origin "$commit:refs/heads/$branch" \
  || fail "the branch $branch of origin could not be moved to $commit: check that origin is reachable and that its branch $branch is not ahead of or diverged from $commit, then run scripts/site-deploy.sh again"

served_dir="$(mktemp -d)"
trap 'rm -rf "$served_dir"' EXIT

content_type_meaning() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[[:space:]]*;[[:space:]]*/;/g; s/^[[:space:]]+//; s/[[:space:]]+$//; s/="([^"]*)"/=\1/g'
}

mismatch=''
served_matches() {
  local file served_type expected_type
  expected_type="$(content_type_meaning "$content_type")"
  for file in "${installers[@]}"; do
    if ! served_type="$(curl --silent --show-error --fail --location --max-time "$FETCH_BOUND_SECONDS" --output "$served_dir/$file" --write-out '%{content_type}' "$origin/$file")"; then
      mismatch="$origin/$file could not be fetched"
      return 1
    fi
    if [ "$(content_type_meaning "$served_type")" != "$expected_type" ]; then
      mismatch="$origin/$file is served as '$served_type', not '$content_type'"
      return 1
    fi
    if ! cmp -s "$served_dir/$file" "$SITE_DIR/$file"; then
      mismatch="$origin/$file is not the $file of this build"
      return 1
    fi
  done
}

step "check the installers served by $origin"
try=1
until served_matches; do
  [ "$try" -lt "$SERVED_TRIES" ] || fail "the branch $branch was moved to $commit, but after $SERVED_TRIES tries $mismatch; run scripts/site-deploy.sh again"
  sleep "$SERVED_PAUSE_SECONDS"
  try=$((try + 1))
done
