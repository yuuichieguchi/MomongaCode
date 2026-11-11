#!/bin/bash
set -euo pipefail

readonly CHECKSUMS_NAME="SHA256SUMS"
readonly SIGNATURE_NAME="SHA256SUMS.sig"
readonly SIGNATURE_NAMESPACE="momonga-release"
readonly EMBEDDED_RELEASE_PUBLIC_KEY=""
readonly EMBEDDED_RELEASE_REPO="yuuichieguchi/MomongaCode"

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
  repo="${MOMONGA_REPO:-$EMBEDDED_RELEASE_REPO}"
  [ -n "$repo" ] || fail "set MOMONGA_REPO=<owner>/<repo> or MOMONGA_RELEASE_BASE_URL"
  if [ -n "${MOMONGA_VERSION:-}" ]; then
    base_url="https://github.com/$repo/releases/download/v$MOMONGA_VERSION"
  else
    base_url="https://github.com/$repo/releases/latest/download"
  fi
fi

public_key="${MOMONGA_RELEASE_PUBLIC_KEY:-$EMBEDDED_RELEASE_PUBLIC_KEY}"
[ -n "$public_key" ] || fail "this installer pins no release signing key, so it cannot verify the release: install from a release whose installer pins the key, or set MOMONGA_RELEASE_PUBLIC_KEY to the ssh public key line the maintainers publish (ssh-ed25519 AAAA...)"
command -v ssh-keygen > /dev/null || fail "ssh-keygen is required to verify the release signature"

loopback_http='^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/.*)?$'
if [[ "$base_url" == https://* ]]; then
  transport="https"
elif [[ "$base_url" =~ $loopback_http ]]; then
  transport="http"
else
  fail "the release location must be https (plain http is accepted only on the loopback interface), got $base_url"
fi

bin_dir="$prefix/bin"
target="$bin_dir/momonga"

mkdir -p "$bin_dir"
staging="$(mktemp -d "$bin_dir/.momonga-install.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

fetch() {
  curl --fail --silent --show-error --location --proto "=$transport" --proto-redir '=https' --output "$2" "$1"
}

fetch "$base_url/$CHECKSUMS_NAME" "$staging/$CHECKSUMS_NAME"
fetch "$base_url/$SIGNATURE_NAME" "$staging/$SIGNATURE_NAME"
printf '%s %s\n' "$SIGNATURE_NAMESPACE" "$public_key" > "$staging/allowed_signers"
ssh-keygen -Y verify -f "$staging/allowed_signers" -I "$SIGNATURE_NAMESPACE" -n "$SIGNATURE_NAMESPACE" -s "$staging/$SIGNATURE_NAME" < "$staging/$CHECKSUMS_NAME" > /dev/null 2>&1 \
  || fail "$CHECKSUMS_NAME is not signed by the pinned release key; nothing was installed"
fetch "$base_url/$ASSET_NAME" "$staging/$ASSET_NAME"

expected="$(awk -v asset="$ASSET_NAME" '{ name = $2; sub(/^\*/, "", name) } name == asset { print $1 }' "$staging/$CHECKSUMS_NAME")"
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
reported="$("$staging/$ASSET_NAME" --version)" || fail "the downloaded executable exited with code $? for --version; nothing was installed"
if [ -n "${MOMONGA_VERSION:-}" ] && [ "$reported" != "$MOMONGA_VERSION" ]; then
  fail "version $MOMONGA_VERSION was asked for, but the downloaded executable reports version $reported; nothing was installed"
fi
mv -f "$staging/$ASSET_NAME" "$target"
printf 'installed momonga to %s\n' "$target"

readonly BEGIN_MARKER="# >>> momonga installer >>>"
readonly END_MARKER="# <<< momonga installer <<<"

shell_name="$(basename "${SHELL:-sh}")"
case "$shell_name" in
  zsh)
    rc_file="${ZDOTDIR:-$HOME}/.zshrc"
    ;;
  bash)
    rc_file="$HOME/.bashrc"
    for candidate in .bashrc .bash_profile .profile; do
      if [ -e "$HOME/$candidate" ]; then
        rc_file="$HOME/$candidate"
        break
      fi
    done
    ;;
  fish)
    rc_file="$HOME/.config/fish/config.fish"
    ;;
  *)
    rc_file="$HOME/.profile"
    ;;
esac

if [ "$shell_name" = "fish" ]; then
  path_line="fish_add_path $bin_dir"
else
  path_line="export PATH=\"$bin_dir:\$PATH\""
fi

case ":$PATH:" in
  *":$bin_dir:"*) exit 0 ;;
esac

if [ "${MOMONGA_MODIFY_PATH:-1}" = "0" ]; then
  printf '%s is not on your PATH. To use momonga in this shell, run:\n\n  %s\n' "$bin_dir" "$path_line"
  exit 0
fi

current_line=""
has_block=0
if [ -f "$rc_file" ]; then
  current_line="$(awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
    $0 == begin { inside = 1; found = 1; next }
    $0 == end { inside = 0; next }
    inside { print; exit }
  ' "$rc_file")"
  if grep -qxF -- "$BEGIN_MARKER" "$rc_file"; then has_block=1; fi
fi

if [ "$has_block" = "1" ] && [ "$current_line" = "$path_line" ]; then
  printf 'PATH is already configured in %s\n' "$rc_file"
elif [ "$has_block" = "1" ]; then
  rewritten="$(mktemp "$bin_dir/.momonga-rc.XXXXXX")"
  PATH_LINE="$path_line" awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
    $0 == begin { print; print ENVIRON["PATH_LINE"]; inside = 1; next }
    $0 == end { inside = 0 }
    !inside { print }
  ' "$rc_file" > "$rewritten"
  cat "$rewritten" > "$rc_file"
  rm -f "$rewritten"
  printf 'PATH line updated in %s\n' "$rc_file"
else
  mkdir -p "$(dirname "$rc_file")"
  if [ -s "$rc_file" ]; then
    if [ -n "$(tail -c 1 "$rc_file")" ]; then printf '\n' >> "$rc_file"; fi
    printf '\n' >> "$rc_file"
  fi
  printf '%s\n%s\n%s\n' "$BEGIN_MARKER" "$path_line" "$END_MARKER" >> "$rc_file"
  printf 'PATH line added to %s\n' "$rc_file"
fi
printf 'To use momonga in this shell now, run:\n\n  %s\n' "$path_line"
