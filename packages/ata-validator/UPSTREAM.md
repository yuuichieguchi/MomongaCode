# ata-validator, the repository copy

This package is a copy of `ata-validator` 1.63.1, loaded by MomongaCode as `@momonga/ata-validator` (the person's decision 60, 2026-11-06).

## Upstream

- Repository: `github.com/ata-core/ata-validator`
- Version copied: 1.63.1, as published to npm. The npm tarball names no commit.
- Licence: MIT, the upstream `LICENSE` unchanged.

## What the copy holds

Only what the product loads: `lite.js`, `lite.d.ts`, `index.d.ts`, the `lib/` files that `lite.js` reaches by `require` (computed by following every `require` of every file), `LICENSE` and `package.json`.

Left out: the native addon packages (`@ata-validator/native-*`), so `lib/native-load.js` finds no addon and the interpreter runs, as it does in the product's bundle; the code generator, the ahead-of-time build, the command line, the browser and edge entries, the README, and the other entry points.

## Files that differ from upstream

- `package.json`: renamed `@momonga/ata-validator`, private, only the `./lite` and `./package.json` entry points, no optional native packages.

## Upstream pull requests

None sent yet.
