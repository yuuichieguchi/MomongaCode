#!/bin/bash
set -euo pipefail

readonly RELEASE_TOOLS=(git node npm gh zig codesign xcrun spctl ditto ssh-keygen shasum)

missing=()
for tool in "${RELEASE_TOOLS[@]}"; do
  command -v "$tool" > /dev/null || missing+=("$tool")
done

count="${#missing[@]}"
[ "$count" -eq 0 ] && exit 0
if [ "$count" -eq 1 ]; then
  printf 'release.sh: a release needs %s on PATH, and it was not found; nothing was built\n' "${missing[0]}" >&2
  exit 1
fi
names="${missing[*]:0:$((count - 1))}"
printf 'release.sh: a release needs %s and %s on PATH, and they were not found; nothing was built\n' "${names// /, }" "${missing[$((count - 1))]}" >&2
exit 1
