import { describe, expect, it } from 'vitest';
import { MINIMUM_PAIRS, buildYieldReport, formatYieldReport, judgeYield } from '@momonga/eval';
import type { YieldFamilyRun, YieldGate } from '@momonga/eval';
import { FAMILY_IDS, SCRIPTED_TARGET, contribution, familyRun, fourFamilies, loadedMemories, reflectionCharge, uniformRuns } from './yield-fixtures.ts';
import type { FamilyShape } from './yield-fixtures.ts';

const SEED = 7;

const RECALLED_FRESH = [loadedMemories([{ id: 'other', status: 'verified' }])];

const CHEAPER: FamilyShape = { without: { calls: [{ cost: 0.01, cached: 400 }] }, with: { calls: [{ cost: 0.004, cached: 400 }], extra: RECALLED_FRESH } };

const CHEAPER_RECALLING_NOTHING: FamilyShape = { without: { calls: [{ cost: 0.01, cached: 400 }] }, with: { calls: [{ cost: 0.004, cached: 400 }] } };

const judged = (runs: YieldFamilyRun[]) => {
  const report = buildYieldReport({ dataset: fourFamilies(), runs, seed: SEED });
  return { report, gate: judgeYield(report, { seed: SEED }) };
};

const checkOf = (gate: YieldGate, name: string) => {
  const check = gate.checks.find((entry) => entry.name === name);
  if (check === undefined) throw new Error(`the gate has no ${name} term among ${gate.checks.map((entry) => entry.name).join(', ')}`);
  return check;
};

describe('the yield gate', () => {
  it('passes when the with arm is cheaper beyond the interval', () => {
    const { report, gate } = judged(uniformRuns(CHEAPER));
    expect(gate.checks.map((check) => check.name)).toEqual(['real_model', 'passRate', 'costPerSuccess', 'memoryStaleRate', 'fabricationRate', 'measuredPairs']);
    expect(gate.checks.filter((check) => !check.passed)).toEqual([]);
    expect(gate.passed).toBe(true);
    expect(report.primaryMetric).toBe('costPerSuccess');
    expect(report.saving?.mean).toBeCloseTo(0.006);
    expect(report.saving?.low).toBeGreaterThan(0);
    expect(formatYieldReport(report, gate)).toContain('gate: PASS');
  });

  it('fails when the arms cost the same', () => {
    const { gate } = judged(uniformRuns({ without: { calls: [{ cost: 0.01, cached: 400 }] }, with: { calls: [{ cost: 0.01, cached: 400 }] } }));
    expect(checkOf(gate, 'costPerSuccess')).toMatchObject({ passed: false });
    expect(checkOf(gate, 'costPerSuccess').detail).toContain('the with arm must be lower');
    expect(checkOf(gate, 'passRate').passed).toBe(true);
    expect(gate.passed).toBe(false);
  });

  it('fails when the pass rate of the with arm is lower beyond the interval', () => {
    const { gate } = judged(uniformRuns({ ...CHEAPER, with: { calls: [{ cost: 0.004, cached: 400 }], status: 'FAILED' } }));
    expect(checkOf(gate, 'passRate')).toMatchObject({ passed: false });
    expect(checkOf(gate, 'passRate').detail).toContain('-1.000');
    expect(gate.passed).toBe(false);
  });

  it('fails with no measure and the cause when the model server reports no cache reads and no price', () => {
    const { report, gate } = judged(uniformRuns({ without: { calls: [{}] }, with: { calls: [{}] }, reflection: { state: 'done', charges: [reflectionCharge(undefined, undefined)] } }));
    expect(report.primaryMetric).toBe('uncachedInputPerSuccess');
    const check = checkOf(gate, 'uncachedInputPerSuccess');
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/^no measure: /);
    expect(check.detail).toContain('cache reads not reported in all 4 call(s)');
    expect(check.detail).toContain('the without arm');
    expect(report).not.toHaveProperty('saving');
    expect(report.families.every((entry) => !('saving' in entry) && !('breakEvenReuses' in entry))).toBe(true);
  });

  it('judges on uncached input when no price is recorded and cache reads are', () => {
    const { report, gate } = judged(uniformRuns({ without: { calls: [{ cached: 100 }] }, with: { calls: [{ cached: 700 }] } }));
    expect(report.primaryMetric).toBe('uncachedInputPerSuccess');
    expect(checkOf(gate, 'uncachedInputPerSuccess').passed).toBe(true);
    expect(report.families[0]?.saving).toBe(600);
    expect(report.families[0]?.breakEvenReuses).toBeCloseTo(400 / 600);
  });

  it('fails when fewer than the minimum of families hold a measured pair', () => {
    const runs = FAMILY_IDS.map((id, index) => familyRun(id, index === 0 ? { without: { calls: [{ cost: 0.01, cached: 400 }] }, with: { calls: [{}] } } : CHEAPER));
    const { gate } = judged(runs);
    const pairs = checkOf(gate, 'measuredPairs');
    expect(pairs.passed).toBe(false);
    expect(pairs.detail).toMatch(new RegExp(`^no measure: ${MINIMUM_PAIRS - 1} of ${MINIMUM_PAIRS} families`));
    expect(gate.passed).toBe(false);
  });

  it('fails real_model when a script answered', () => {
    const { gate } = judged(uniformRuns({ ...CHEAPER, answerer: SCRIPTED_TARGET }));
    expect(checkOf(gate, 'real_model').passed).toBe(false);
    expect(checkOf(gate, 'costPerSuccess').passed).toBe(true);
  });

  it('fails memoryStaleRate when the with arm recalls stale memories in every family', () => {
    const stale = uniformRuns({ ...CHEAPER, with: { calls: [{ cost: 0.004, cached: 400 }], extra: [loadedMemories([{ id: 'other', status: 'stale' }])] } });
    expect(checkOf(judged(stale).gate, 'memoryStaleRate').passed).toBe(false);
    const fresh = uniformRuns({ ...CHEAPER, with: { calls: [{ cost: 0.004, cached: 400 }], extra: [loadedMemories([{ id: 'other', status: 'verified' }])] } });
    expect(checkOf(judged(fresh).gate, 'memoryStaleRate').passed).toBe(true);
  });

  it('measures memoryStaleRate in the with arm only, and fails it with no measure when that arm recalls no memory', () => {
    const { report, gate } = judged(uniformRuns(CHEAPER_RECALLING_NOTHING));
    for (const entry of report.families) expect(entry.reuse.without).not.toHaveProperty('memoryStaleRate');
    expect(report.metrics.without).not.toHaveProperty('memoryStaleRate');
    const check = checkOf(gate, 'memoryStaleRate');
    expect(check.passed).toBe(false);
    expect(check.detail).toContain('no measure');
  });
});

describe('the derived figures of a yield report', () => {
  it('gives the saving per family and breakEvenReuses as the reflection charge divided by the saving', () => {
    const { report } = judged(uniformRuns(CHEAPER));
    for (const entry of report.families) {
      expect(entry.saving).toBeCloseTo(0.006);
      expect(entry.breakEvenReuses).toBeCloseTo(0.003 / 0.006);
      expect(entry.learn.reflection).toMatchObject({ state: 'done', calls: 1, inputTokens: 500, outputTokens: 40, cost: 0.003 });
    }
    expect(report.breakEvenReuses).toBeCloseTo(0.5);
  });

  it('leaves breakEvenReuses absent when the saving is not above 0', () => {
    const equal = judged(uniformRuns({ without: { calls: [{ cost: 0.01, cached: 400 }] }, with: { calls: [{ cost: 0.01, cached: 400 }] } })).report;
    expect(equal.families.map((entry) => entry.saving)).toEqual([0, 0, 0, 0]);
    expect(equal.families.some((entry) => 'breakEvenReuses' in entry)).toBe(false);
    expect(equal).not.toHaveProperty('breakEvenReuses');
    const dearer = judged(uniformRuns({ without: { calls: [{ cost: 0.01, cached: 400 }] }, with: { calls: [{ cost: 0.02, cached: 400 }] } })).report;
    expect(dearer.families[0]?.saving).toBeCloseTo(-0.01);
    expect(dearer.families.some((entry) => 'breakEvenReuses' in entry)).toBe(false);
    expect(JSON.stringify(dearer)).not.toContain('Infinity');
  });

  it('counts the accepted memories the with arm recalled and those that contributed', () => {
    const runs = uniformRuns({
      ...CHEAPER,
      candidates: [
        { text: 'fact-of-port fact-of-codename fact-of-tag fact-of-variable one', paths: [] },
        { text: 'fact-of-port fact-of-codename fact-of-tag fact-of-variable two', paths: [] },
      ],
      seeded: ['m-a', 'm-b'],
      with: {
        calls: [{ cost: 0.004, cached: 400 }],
        extra: [
          loadedMemories([
            { id: 'm-a', status: 'verified' },
            { id: 'm-b', status: 'verified' },
            { id: 'unrelated', status: 'verified' },
          ]),
          contribution([
            { id: 'm-a', contributed: true },
            { id: 'm-b', contributed: false },
            { id: 'unrelated', contributed: true },
          ]),
        ],
      },
    });
    const { report } = judged(runs);
    expect(report.families[0]).toMatchObject({ recalledAccepted: 2, contributed: 1 });
  });

  it('keeps the per-success figures of both arms and the report identity', () => {
    const { report } = judged(uniformRuns(CHEAPER));
    expect(report.families[0]?.reuse.without).toMatchObject({ passed: true, costPerSuccess: 0.01, callsPerSuccess: 1 });
    expect(report.families[0]?.reuse.with).toMatchObject({ passed: true, costPerSuccess: 0.004, callsPerSuccess: 1 });
    expect(report.metrics.without.costPerSuccess?.value).toBeCloseTo(0.01);
    expect(report.metrics.with.costPerSuccess?.value).toBeCloseTo(0.004);
    expect(report).toMatchObject({ dataset: 'yield', model: 'real', models: ['p/m'], codeDigest: 'c'.repeat(64) });
    expect(report.policy.memory?.reflection?.enabled).toBe(true);
    expect(report.datasetDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
