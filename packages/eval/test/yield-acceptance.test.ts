import { describe, expect, it } from 'vitest';
import { YIELD_ACCEPTANCE, YIELD_REPORT_KIND, acceptedByAnchors, buildYieldReport, encodeYieldReport, formatYieldReport, judgeYield } from '@momonga/eval';
import { FAMILY_IDS, anchorOf, familyRun, fourFamilies } from './yield-fixtures.ts';

const SEED = 7;

const keysOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, below]) => [key, ...keysOf(below)]);
};

const reportOf = () =>
  buildYieldReport({
    dataset: fourFamilies(),
    seed: SEED,
    runs: FAMILY_IDS.map((id) =>
      familyRun(id, {
        without: { calls: [{ cost: 0.01, cached: 400 }] },
        with: { calls: [{ cost: 0.004, cached: 400 }] },
        candidates: [
          { text: `The value is ${anchorOf(id)}.`, paths: ['notes.txt'] },
          { text: 'The check passes.', paths: [] },
          { text: `the value is ${anchorOf(id).toUpperCase()}`, paths: [] },
        ],
      }),
    ),
  });

describe('acceptance by the dataset anchors', () => {
  it('accepts a candidate exactly when its text holds an anchor, case-sensitive, and rejects the rest', () => {
    const candidates = [
      { text: 'the port is 4317', paths: [] },
      { text: 'the port is 4318', paths: [] },
      { text: 'Use AMBER-FALCON', paths: [] },
      { text: 'the name is amber-falcon', paths: ['a.txt'] },
    ];
    expect(acceptedByAnchors(candidates, ['4317', 'amber-falcon'])).toEqual({ accepted: [candidates[0], candidates[3]], rejected: [candidates[1], candidates[2]] });
    expect(acceptedByAnchors(candidates, ['absent'])).toEqual({ accepted: [], rejected: candidates });
  });

  it('counts the candidates, the accepted and the rejected of the learn session', () => {
    const report = reportOf();
    expect(report.families.map((entry) => [entry.learn.candidates, entry.learn.accepted, entry.learn.rejected])).toEqual(FAMILY_IDS.map(() => [3, 1, 2]));
  });

  it('stores the rule as data and names it in the printed text', () => {
    const report = reportOf();
    expect(report.kind).toBe(YIELD_REPORT_KIND);
    expect(YIELD_REPORT_KIND).toBe('momonga.eval.yield/1');
    expect(report.acceptance).toBe(YIELD_ACCEPTANCE);
    expect(YIELD_ACCEPTANCE).toBe('dataset-anchors');
    expect(JSON.parse(encodeYieldReport(report))).toMatchObject({ kind: 'momonga.eval.yield/1', acceptance: 'dataset-anchors' });
    const lines = formatYieldReport(report, judgeYield(report, { seed: SEED })).split('\n');
    const figures = lines.filter((line) => /saving|breakEvenReuses|accepted|family /.test(line));
    expect(figures.length).toBeGreaterThan(FAMILY_IDS.length);
    for (const line of figures) expect(line).toContain('if accepted by the dataset anchors');
  });

  it('names no field and prints no text for the acceptance of a person', () => {
    const report = reportOf();
    const person = /person|human|user|review|approv/i;
    expect(keysOf(JSON.parse(encodeYieldReport(report))).filter((key) => person.test(key))).toEqual([]);
    expect(formatYieldReport(report, judgeYield(report, { seed: SEED }))).not.toMatch(person);
  });
});
