import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { moduleSpecifiersOf, productSources, relativeOf } from './support/source-scan.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const GLOB_MODULE = 'packages/foundation/src/glob-match.ts';

const GLOB_COMPILERS = new Set(['picomatch', 'minimatch', 'micromatch', 'tinyglobby', 'fdir', 'fast-glob', 'globby', 'glob']);

const GLOB_TO_REGEXP = /\bglob\w*\s*(?::[^=]*)?=[^;\n]*new RegExp|new RegExp\([^)]*\bglob|globToRegExp|matchesGlob/i;

describe('every untrusted glob is compiled by the one glob module', () => {
  it('no product source imports a glob compiler', () => {
    const offenders = productSources().flatMap((file) => moduleSpecifiersOf(file).filter((specifier) => GLOB_COMPILERS.has(specifier)).map((specifier) => `${relativeOf(file)}: ${specifier}`));
    expect(offenders).toEqual([]);
  });

  it('no product source outside the glob module builds a regular expression from a glob', () => {
    const offenders = productSources()
      .filter((file) => relativeOf(file) !== GLOB_MODULE)
      .filter((file) => GLOB_TO_REGEXP.test(fs.readFileSync(file, 'utf8')))
      .map(relativeOf);
    expect(offenders).toEqual([]);
  });

  it('the glob module itself builds no regular expression', () => {
    expect(fs.readFileSync(`${import.meta.dirname}/../${GLOB_MODULE}`, 'utf8')).not.toMatch(/new RegExp|\/[^/\n]+\/[dgimsuvy]*\.test\(/);
  });

  it('recognises the shapes it refuses', () => {
    expect(['const globOf = (glob: string): RegExp => new RegExp(x);', 'new RegExp(glob)', "import picomatch from 'picomatch';"].map((text) => GLOB_TO_REGEXP.test(text))).toEqual([true, true, false]);
  });
});
