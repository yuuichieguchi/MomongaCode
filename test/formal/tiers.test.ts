import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cfgNames } from './cfg-names.ts';
import type { CfgNames } from './cfg-names.ts';
import { moduleOf, readManifest } from './manifest.ts';
import type { ManifestEntry } from './manifest.ts';

const specDir = path.resolve(import.meta.dirname, '..', '..', 'specs', 'tla');
const manifestPath = path.join(specDir, 'manifest.json');
const manifest = readManifest(manifestPath);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const rawEntries = (): readonly Record<string, unknown>[] => {
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed['entries'])) throw new Error('the TLA manifest has no entries array');
  return parsed['entries'].filter(isRecord);
};

const checkedNames = (entry: ManifestEntry): readonly string[] => {
  const names = cfgNames(specDir, entry.config);
  return [...names.invariants, ...names.properties];
};

const evidenceKeyOf = (entry: ManifestEntry): string =>
  entry.expect === 'holds' ? `${entry.config} holds` : `${moduleOf(entry.config)} violates ${entry.expect.violates}`;

const groupBy = <T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
};

const isLivenessRow = (entry: ManifestEntry): boolean => entry.args.includes('-lncheck');

const uncoveredNames = (entries: readonly ManifestEntry[], namesOf: (entry: ManifestEntry) => CfgNames): string[] => {
  const problems: string[] = [];
  for (const [module, checks] of groupBy(
    entries.filter((entry) => entry.role === 'check'),
    (entry) => moduleOf(entry.config),
  )) {
    const everyRun = checks.filter((entry) => entry.tier === 'every-run');
    const covered = new Set(everyRun.flatMap((entry) => [...namesOf(entry).invariants, ...namesOf(entry).properties]));
    const splitLiveness = new Set(checks.filter((entry) => entry.tier === 'deep' && isLivenessRow(entry)).flatMap((entry) => namesOf(entry).properties));
    const required = new Set(checks.flatMap((entry) => [...namesOf(entry).invariants, ...namesOf(entry).properties.filter((name) => !splitLiveness.has(name))]));
    for (const name of required) if (!covered.has(name)) problems.push(`${module}: ${name} is checked by no every-run check row`);
  }
  return problems;
};

const evidenceTierProblems = (entries: readonly ManifestEntry[]): string[] => {
  const problems: string[] = [];
  for (const [key, rows] of groupBy(
    entries.filter((entry) => entry.role === 'evidence'),
    evidenceKeyOf,
  )) {
    const everyRun = rows.filter((entry) => entry.tier === 'every-run');
    if (everyRun.length !== 1) {
      problems.push(`${key}: ${everyRun.length} every-run evidence rows (${everyRun.map((entry) => entry.config).join(', ')}), one is required`);
      continue;
    }
    const smallest = Math.min(...rows.map((entry) => entry.distinctStates));
    const kept = everyRun[0] as ManifestEntry;
    if (kept.distinctStates !== smallest) problems.push(`${key}: the every-run row ${kept.config} has ${kept.distinctStates} distinct states, another evidence row of the property has ${smallest}`);
  }
  return problems;
};

const sameConstants = (left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean =>
  Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([name, value]) => right[name] === value);

const redundantCheckRows = (
  entries: readonly ManifestEntry[],
  constantsOf: (entry: ManifestEntry) => Readonly<Record<string, string>>,
  namesOf: (entry: ManifestEntry) => readonly string[],
): string[] => {
  const checks = entries.filter((entry) => entry.role === 'check' && entry.tier === 'every-run');
  const problems: string[] = [];
  for (const row of checks) {
    const covering = checks.find(
      (other) =>
        other !== row &&
        moduleOf(other.config) === moduleOf(row.config) &&
        sameConstants(constantsOf(other), constantsOf(row)) &&
        namesOf(row).every((name) => namesOf(other).includes(name)) &&
        (namesOf(other).length > namesOf(row).length || other.config < row.config),
    );
    if (covering !== undefined) problems.push(`${row.config} adds nothing to ${covering.config}: same constants, no name of its own`);
  }
  return problems;
};

const everyRunWallSeconds = (entries: readonly ManifestEntry[]): number =>
  entries.filter((entry) => entry.tier === 'every-run').reduce((total, entry) => total + entry.measuredSeconds, 0);

const UNMEASURED_NOTE = /to be re-measured|not in the cold window|above the load gate/;

const sample = (config: string, overrides: Partial<ManifestEntry>): ManifestEntry => ({
  config,
  role: 'check',
  expect: 'holds',
  args: [],
  tier: 'every-run',
  distinctStates: 10,
  measuredSeconds: 1,
  measuredCpuSeconds: 1,
  budgetCpuSeconds: 5,
  ...overrides,
});

describe('the rules that choose the every-run rows (formal-models C20, E1 to E7)', () => {
  it('E1 fails a name that only a deep check row checks, except a liveness property split into a deep liveness row (E3)', () => {
    const names: Record<string, CfgNames> = {
      M: { constants: {}, invariants: ['A'], properties: [] },
      'M.big': { constants: {}, invariants: ['A', 'B'], properties: ['Live'] },
      'M.live': { constants: {}, invariants: [], properties: ['Ends'] },
    };
    const entries = [sample('M', {}), sample('M.big', { tier: 'deep' }), sample('M.live', { tier: 'deep', args: ['-lncheck', 'final'] })];
    const namesOf = (entry: ManifestEntry): CfgNames => names[entry.config] ?? { constants: {}, invariants: [], properties: [] };
    expect(uncoveredNames(entries, namesOf)).toEqual(['M: B is checked by no every-run check row', 'M: Live is checked by no every-run check row']);
  });

  it('E2 fails two every-run evidence rows of one property, and an every-run row that is not the smallest', () => {
    const bad = { violates: 'Safe', exitCode: 12 } as const;
    const twice = [sample('M.a', { role: 'evidence', expect: bad }), sample('M.b', { role: 'evidence', expect: bad })];
    expect(evidenceTierProblems(twice)).toEqual(['M violates Safe: 2 every-run evidence rows (M.a, M.b), one is required']);
    const larger = [sample('M.a', { role: 'evidence', expect: bad, distinctStates: 50 }), sample('M.b', { role: 'evidence', expect: bad, tier: 'deep', distinctStates: 5 })];
    expect(evidenceTierProblems(larger)).toEqual(['M violates Safe: the every-run row M.a has 50 distinct states, another evidence row of the property has 5']);
  });

  it('E4 fails an every-run check row with the same constants and no name of its own', () => {
    const names: Record<string, readonly string[]> = { M: ['A', 'B'], 'M.part': ['A'] };
    const entries = [sample('M', {}), sample('M.part', {})];
    expect(redundantCheckRows(entries, () => ({ N: '2' }), (entry) => names[entry.config] ?? [])).toEqual(['M.part adds nothing to M: same constants, no name of its own']);
  });

  it('E1: every invariant and property of a spec is checked by an every-run check row', () => {
    expect(uncoveredNames(manifest.entries, (entry) => cfgNames(specDir, entry.config))).toEqual([]);
  });

  it('E2: each evidence property has one every-run row, the one with the fewest distinct states', () => {
    expect(evidenceTierProblems(manifest.entries)).toEqual([]);
  });

  it('E4: no every-run check row repeats another with the same constants', () => {
    expect(redundantCheckRows(manifest.entries, (entry) => cfgNames(specDir, entry.config).constants, checkedNames)).toEqual([]);
  });

  it('E6: the cold wall of the every-run rows is at most the unit suite wall time', () => {
    expect(everyRunWallSeconds(manifest.entries)).toBeLessThanOrEqual(manifest.unitSuiteSeconds);
  });

  it('E7: no row carries a measurement that is waiting to be repeated', () => {
    const waiting = rawEntries().filter((entry) => [entry['note'], entry['measuredNote']].some((note) => typeof note === 'string' && UNMEASURED_NOTE.test(note)));
    expect(waiting.map((entry) => entry['config'])).toEqual([]);
  });
});
