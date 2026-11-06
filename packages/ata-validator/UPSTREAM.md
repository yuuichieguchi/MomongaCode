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
- `lib/multiple-of.js` (new file): `multipleOfOk`, the one function that decides `multipleOf`. It reads each number as its shortest round-trip decimal (`Number.prototype.toString`) and tests divisibility with `BigInt` over a common decimal scale. Defect fixed: upstream divided as floating point and accepted a quotient within 1e-9 of a whole number, so `1e20` was a multiple of 3 and `1e308` was not a multiple of 0.5.
- `lib/interpreter-core.js`: its own `multipleOfOk` removed, the one function required instead. Upstream comments removed.
- `lib/tier0.js`: its own `_multipleOk` (the second place that decided `multipleOf`) removed, the one function required instead. Upstream comments removed.
- `lib/safe-regex.js`: the Pike VM reads the pattern and the input by code point (`Array.from` for the pattern, `codePointAt` for the input, including the lazy DFA's last-character step), as an ECMA-262 pattern with the `u` flag does. A pair of `\uD83D\uDC32` escapes is one character. Defect fixed: a quantifier after an astral character repeated half of it, and `.` and astral ranges matched half a character. Upstream comments removed.

## Upstream pull requests

None sent yet.
