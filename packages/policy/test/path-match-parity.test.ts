import ignore from 'ignore';
import { describe, expect, it } from 'vitest';
import { HOST_FLAVOUR, HOST_RULE_ENFORCEMENT, compileFileRuleSet, fileRuleBlocks } from '@momonga/foundation';
import type { FileRuleSpec, PathResolution } from '@momonga/foundation';
import { PARITY_CANDIDATES, PARITY_SPECS } from './parity-table.ts';
import type { ParityRow } from './parity-table.ts';

const ROOT = '/w';

const identity = (absolute: string): PathResolution => ({ ok: true, path: absolute });

const specOf = (specifier: string): FileRuleSpec => ({
  ruleIndex: 0,
  tool: 'Read',
  access: 'read',
  effect: 'deny',
  specifier,
  exceptions: [],
  context: { roots: [ROOT], home: '/h', settingsRoot: ROOT, effect: 'deny' },
  provenance: { ruleText: `Read(${specifier})`, layer: 'user', source: 'parity' },
});

const oracleBlocks = (row: ParityRow, candidate: string): boolean => ignore({ ignorecase: false }).add([...row.gitignore]).ignores(candidate);

const engineBlocks = (row: ParityRow, candidate: string): boolean => {
  const set = compileFileRuleSet([specOf(row.specifier)], [ROOT], null, identity, () => false, HOST_FLAVOUR, HOST_RULE_ENFORCEMENT);
  const absolute = `${ROOT}/${candidate}`;
  return set.entries.some((entry) => fileRuleBlocks(set, entry, absolute, absolute));
};

describe('exact matcher parity with gitignore', () => {
  const pairs = PARITY_SPECS.flatMap((row) => PARITY_CANDIDATES.map((candidate) => [row.specifier, candidate, row] as const));

  it('the oracle table is not vacuous', () => {
    const blocked = pairs.filter(([, candidate, row]) => oracleBlocks(row, candidate));
    expect(blocked.length).toBeGreaterThan(40);
    expect(blocked.length).toBeLessThan(pairs.length);
  });

  it.each(pairs)('%s against %s agrees with the gitignore oracle', (_specifier, candidate, row) => {
    expect(engineBlocks(row, candidate)).toBe(oracleBlocks(row, candidate));
  });
});
