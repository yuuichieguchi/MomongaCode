import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RIPGREP_VERSION } from '../../../../scripts/ripgrep-release.ts';
import { HAS_REAL_SANDBOX } from '../helpers.ts';
import { BASE_PATH, HAS_RG, RG_BIN, RG_PATH } from './fixtures.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PINNED_CACHE = path.join(REPO_ROOT, '.cache', 'ripgrep');

describe('the unit fixtures ripgrep', () => {
  it('hands tests the pinned ripgrep extracted into the repository cache, not a host path', () => {
    expect(path.isAbsolute(RG_BIN)).toBe(true);
    expect(path.relative(PINNED_CACHE, RG_BIN).startsWith('..')).toBe(false);
    expect(fs.statSync(RG_BIN).isFile()).toBe(true);
    expect(execFileSync(RG_BIN, ['--version'], { encoding: 'utf8' }).split('\n')[0]).toMatch(new RegExp(`^ripgrep ${RIPGREP_VERSION.replaceAll('.', '\\.')}( |$)`));
  });

  it('puts the pinned ripgrep directory ahead of the base PATH', () => {
    expect(RG_PATH).toBe(`${path.dirname(RG_BIN)}${path.delimiter}${BASE_PATH}`);
  });

  it('gates ripgrep tests on the real sandbox alone', () => {
    expect(HAS_RG).toBe(HAS_REAL_SANDBOX);
  });
});
