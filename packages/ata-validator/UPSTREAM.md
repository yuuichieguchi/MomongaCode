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
- `lib/interpreter-core.js`: its own `multipleOfOk` removed, the one function required instead. The native-`RegExp` branch of `plainLinear` (a pattern of at most one loop and 64 choices) no longer admits `.`, `\D`, `\W`, `\S` or a negated class: those atoms match half of an astral character under a `RegExp` without the `u` flag, so they go to the code-point Pike VM. Upstream comments removed.
- `lib/tier0.js`: its own `_multipleOk` (the second place that decided `multipleOf`) removed, the one function required instead. Upstream comments removed.
- `lib/safe-regex.js`: the Pike VM reads the pattern and the input by code point (`Array.from` for the pattern, `codePointAt` for the input, including the lazy DFA's last-character step), as an ECMA-262 pattern with the `u` flag does. A pair of `\uD83D\uDC32` escapes is one character. Defect fixed: a quantifier after an astral character repeated half of it, and `.` and astral ranges matched half a character. Upstream comments removed.
- `lib/idna2008.js` (new file): the `idn-hostname` check and the A-label check of `hostname`. Defect fixed: upstream had no `idn-hostname` check at all (every string passed) and accepted any `xn--` label as a `hostname`. The rules are RFC 5890 to 5893 (IDNA2008) and RFC 3492 (Punycode):
  - U-label: NFC, no leading mark, no hyphen at either end or in positions 3 and 4, every code point PVALID or CONTEXTJ/CONTEXTO with its rule satisfied (RFC 5892 section 2 and appendix A, including its exceptions table), Bidi rule (RFC 5893) over the whole domain;
  - A-label: Punycode decodes, the result has a non-ASCII code point, is a valid U-label, and encodes back to the same text;
  - lengths: 63 octets per label and 253 for the name, in the ASCII form;
  - `idn-hostname` first maps the input as UTS 46 does, approximated: the label separators U+3002, U+FF0E and U+FF61 become a dot, default-ignorable code points other than U+200C and U+200D are dropped, each remaining code point is mapped by NFKC and lower-casing, then the text is normalised to NFC. This is not the UTS 46 mapping table: a code point whose case folding is not its lower case (for example the Cherokee small letters) is refused by the Unstable rule instead of mapped.
  - Derived properties that JavaScript exposes (`\p{Cn}`, `\p{Ll}` and the other general categories, `Default_Ignorable_Code_Point`, `White_Space`, `Noncharacter_Code_Point`, `Changes_When_NFKC_Casefolded`, `Script`) are read from the runtime at the time of the check, so they follow the Unicode version of the Node.js that runs it.
- `lib/idna2008-tables.js` (new file, generated): ranges of the properties JavaScript does not expose: Bidi_Class (R, AL, EN, AN, NSM and the neutral classes ES, ET, CS, ON, BN), Joining_Type (D, L, R, T), Canonical_Combining_Class 9 (virama) and Hangul_Syllable_Type L, V and T. Generated on 2026-11-06 from ICU 78.3 (Unicode 17.0.0, `u_getIntPropertyValue` through the `libicuuc` of Homebrew `icu4c@78`), with the Bidi and Joining ranges kept only for code points that `derivedProperty` of `lib/idna2008.js` accepts. Regenerate it the same way when the Unicode version of the runtime moves.
- `lib/formats.js`: `hostname` runs the A-label check after its RFC 1123 walk, and `idn-hostname` is registered. The `email` check reads its domain through `hostname`, so an `xn--` label in an email domain is now checked the same way. Upstream comments removed.

## Upstream pull requests

None sent yet.
