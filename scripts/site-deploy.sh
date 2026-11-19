#!/bin/bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SITE_DIR="$ROOT/dist/site"
readonly SITE_TOOLS=(git node wrangler curl cmp)
readonly SITE_VARIABLES=(CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID)
readonly DEPLOY_BOUND_SECONDS=600
readonly FETCH_BOUND_SECONDS=30
readonly SERVED_TRIES=12
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
for name in "${SITE_VARIABLES[@]}"; do
  [ -n "${!name:-}" ] || fail "$name is not set; set it in the environment of the deploy; nothing was deployed"
done

cd "$ROOT"
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean; commit or remove the changes and check out the released tag; nothing was deployed"
version="$(node --print "JSON.parse(require('node:fs').readFileSync('packages/cli/package.json', 'utf8')).version")"
[ -n "$version" ] || fail "packages/cli/package.json has no version; nothing was deployed"
tag="v$version"
git fetch --quiet --no-tags origin "refs/tags/$tag" || fail "tag $tag is not on origin; the site is deployed only for a published release"
tagged="$(git rev-parse --verify --quiet 'FETCH_HEAD^{commit}')" || fail "tag $tag on origin names no commit; nothing was deployed"
[ "$(git rev-parse HEAD)" = "$tagged" ] || fail "HEAD is not the commit of tag $tag on origin; check out $tag to deploy its site"

origin="$(node "$ROOT/scripts/site-target.ts" print-origin)"
project="$(node "$ROOT/scripts/site-target.ts" print-project)"
content_type="$(node "$ROOT/scripts/site-target.ts" print-installer-content-type)"
listing="$(node "$ROOT/scripts/site-target.ts" print-installers)"
installers=()
while IFS= read -r file; do
  installers+=("$file")
done <<< "$listing"

step "build the site of $tag"
node "$ROOT/scripts/site.ts" --output "$SITE_DIR"

step "deploy the site to the Cloudflare Pages project $project"
node "$ROOT/scripts/site/bounded.ts" "$DEPLOY_BOUND_SECONDS" wrangler pages deploy "$SITE_DIR" --project-name "$project" --branch main

served_dir="$(mktemp -d)"
trap 'rm -rf "$served_dir"' EXIT

mismatch=''
served_matches() {
  local file served_type
  for file in "${installers[@]}"; do
    if ! served_type="$(curl --silent --show-error --fail --location --max-time "$FETCH_BOUND_SECONDS" --output "$served_dir/$file" --write-out '%{content_type}' "$origin/$file")"; then
      mismatch="$origin/$file could not be fetched"
      return 1
    fi
    if [ "$served_type" != "$content_type" ]; then
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
  [ "$try" -lt "$SERVED_TRIES" ] || fail "the site was deployed, but after $SERVED_TRIES tries $mismatch; run scripts/site-deploy.sh again"
  sleep "$SERVED_PAUSE_SECONDS"
  try=$((try + 1))
done
