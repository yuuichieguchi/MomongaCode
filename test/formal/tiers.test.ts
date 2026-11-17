import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cfgNames } from './cfg-names.ts';
import { specIdentityOf } from './reuse.ts';
import { recordsTier } from './record.ts';
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

const evidenceWithoutRow = (entries: readonly ManifestEntry[], namesOf: (entry: ManifestEntry) => CfgNames): string[] => {
  const problems: string[] = [];
  for (const [module, rows] of groupBy(entries, (entry) => moduleOf(entry.config))) {
    const violated = new Set(rows.flatMap((entry) => (entry.expect === 'holds' ? [] : [entry.expect.violates])));
    const named = new Set(rows.filter((entry) => entry.role === 'evidence').flatMap((entry) => [...namesOf(entry).invariants, ...namesOf(entry).properties]));
    for (const name of named) if (!violated.has(name) && !rows.some((entry) => entry.role === 'check' && [...namesOf(entry).invariants, ...namesOf(entry).properties].includes(name))) problems.push(`${module}: ${name} is named by evidence but checked by no row`);
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
    if (everyRun.length === 0) continue;
    if (everyRun.length > 1) {
      problems.push(`${key}: ${everyRun.length} every-run evidence rows (${everyRun.map((entry) => entry.config).join(', ')}), at most one is allowed`);
      continue;
    }
    const smallest = Math.min(...rows.map((entry) => entry.distinctStates));
    const kept = everyRun[0] as ManifestEntry;
    if (kept.distinctStates !== smallest) problems.push(`${key}: the every-run row ${kept.config} has ${kept.distinctStates} distinct states, another evidence row of the property has ${smallest}`);
  }
  return problems;
};

const everyRunWallSeconds = (entries: readonly ManifestEntry[]): number =>
  entries.filter((entry) => entry.tier === 'every-run').reduce((total, entry) => total + entry.measuredSeconds, 0);

const outOfOrderDeepRows = (entries: readonly ManifestEntry[], unitSuiteSeconds: number): string[] => {
  const everyRun = entries.filter((entry) => entry.tier === 'every-run');
  const heaviest = Math.max(0, ...everyRun.map((entry) => entry.measuredSeconds));
  const sum = everyRunWallSeconds(entries);
  const keptEvidence = new Set(everyRun.filter((entry) => entry.role === 'evidence').map(evidenceKeyOf));
  return entries
    .filter((entry) => entry.tier === 'deep' && entry.measuredSeconds < heaviest && sum + entry.measuredSeconds <= unitSuiteSeconds)
    .filter((entry) => !(entry.role === 'evidence' && keptEvidence.has(evidenceKeyOf(entry))))
    .map((entry) => `${entry.config} (${entry.measuredSeconds} s) is deep, lighter than an every-run row, and fits within the unit suite time`);
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
  identity: '0'.repeat(64),
  ...overrides,
});

describe('the rules that choose the every-run rows (formal-models C20, E1 to E7)', () => {
  it('E1 fails a name that evidence names and no row of either tier checks or violates', () => {
    const names: Record<string, CfgNames> = { 'M.bug': { constants: {}, invariants: ['A', 'B'], properties: [] }, M: { constants: {}, invariants: ['B'], properties: [] } };
    const bad = { violates: 'X', exitCode: 12 } as const;
    const entries = [sample('M.bug', { role: 'evidence', expect: bad, tier: 'deep' }), sample('M', { tier: 'deep' })];
    const namesOf = (entry: ManifestEntry): CfgNames => names[entry.config] ?? { constants: {}, invariants: [], properties: [] };
    expect(evidenceWithoutRow(entries, namesOf)).toEqual(['M: A is named by evidence but checked by no row']);
  });

  it('the heaviest-first order fails a deep row that is lighter than an every-run row and would still fit', () => {
    const entries = [sample('M', { measuredSeconds: 5 }), sample('M.light', { tier: 'deep', measuredSeconds: 2 }), sample('M.heavy', { tier: 'deep', measuredSeconds: 9 })];
    expect(outOfOrderDeepRows(entries, 8)).toEqual(['M.light (2 s) is deep, lighter than an every-run row, and fits within the unit suite time']);
    expect(outOfOrderDeepRows(entries, 6)).toEqual([]);
  });

  it('E2 fails two every-run evidence rows of one property, and an every-run row that is not the smallest of its property', () => {
    const bad = { violates: 'Safe', exitCode: 12 } as const;
    const twice = [sample('M.a', { role: 'evidence', expect: bad }), sample('M.b', { role: 'evidence', expect: bad })];
    expect(evidenceTierProblems(twice)).toEqual(['M violates Safe: 2 every-run evidence rows (M.a, M.b), at most one is allowed']);
    const larger = [sample('M.a', { role: 'evidence', expect: bad, distinctStates: 50 }), sample('M.b', { role: 'evidence', expect: bad, tier: 'deep', distinctStates: 5 })];
    expect(evidenceTierProblems(larger)).toEqual(['M violates Safe: the every-run row M.a has 50 distinct states, another evidence row of the property has 5']);
  });

  it('E4 fails an every-run check row with the same constants and no name of its own', () => {
    const names: Record<string, readonly string[]> = { M: ['A', 'B'], 'M.part': ['A'] };
    const entries = [sample('M', {}), sample('M.part', {})];
    expect(redundantCheckRows(entries, () => ({ N: '2' }), (entry) => names[entry.config] ?? [])).toEqual(['M.part adds nothing to M: same constants, no name of its own']);
  });

  it('E1: every name an evidence row names is checked or violated by a row of either tier', () => {
    expect(evidenceWithoutRow(manifest.entries, (entry) => cfgNames(specDir, entry.config))).toEqual([]);
  });

  it('the heaviest-first order: no deep row could come back to the every-run tier within the unit suite time', () => {
    expect(outOfOrderDeepRows(manifest.entries, manifest.unitSuiteSeconds)).toEqual([]);
  });

  it('E2: an evidence property has at most one every-run row, the one with the fewest distinct states', () => {
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

describe('the recorded identity of every row', () => {
  it('matches the spec closure, cfg, JSON inputs and args that the row was measured with', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const recording = recordsTier(process.env['MOMONGA_TLC_TIER'] === 'deep' ? 'deep' : 'every-run', process.env);
    const stale: string[] = [];
    for (const entry of manifest.entries) if (entry.identity !== (await specIdentityOf(repoRoot, entry)) && !(recording && entry.tier === 'deep')) stale.push(entry.config);
    expect(stale, `re-measure these rows with scripts/tlc-record.ts: ${stale.join(', ')}`).toEqual([]);
  });
});
