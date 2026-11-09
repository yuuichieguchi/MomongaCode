# Third-party notices

The Momonga Code executable embeds the third-party components listed here. Each entry names the component, its version, its licence and where its full notice text is.

## ripgrep

- Version: 15.2.0, the official release binaries from https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0, pinned by sha256 in `scripts/ripgrep-release.ts`.
- Copyright: Andrew Gallant.
- Licence: dual-licensed under the Unlicense or the MIT License, at your choice.
- Notice text: the upstream files `COPYING`, `UNLICENSE` and `LICENSE-MIT`, unmodified, are embedded in the executable and written as `NOTICE.txt` beside the extracted `rg`, in `executables/ripgrep-15.2.0-<hash>/` under the Momonga Code cache directory (`~/Library/Caches/momonga` on macOS, `$XDG_CACHE_HOME/momonga` or `~/.cache/momonga` on Linux, `%LOCALAPPDATA%\momonga` on Windows).
