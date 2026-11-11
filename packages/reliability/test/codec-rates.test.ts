import { describe, expect, it } from 'vitest';
import { MIN_RATE_POPULATION } from '@momonga/protocol';
import { aggregate, buildReliabilityReport, decodeReliabilityReport, encodeReliabilityReport, formatReliabilityReport } from '@momonga/reliability';

type Json = Record<string, unknown>;

const currentReport = (): Json => JSON.parse(encodeReliabilityReport(buildReliabilityReport({ kind: 'real', aggregate: aggregate([], { groupBy: 'model' }) }))) as Json;

const withTotal = (change: (total: Json) => Json): string => {
  const report = currentReport();
  return JSON.stringify({ ...report, total: change(report['total'] as Json) });
};

const OVER = { k: MIN_RATE_POPULATION + 1, n: MIN_RATE_POPULATION };

const RATES: readonly (readonly [string, (total: Json) => Json])[] = [
  ['report.total.completion', (total) => ({ ...total, completion: { ...(total['completion'] as Json), ...OVER } })],
  ['report.total.recovery', (total) => ({ ...total, recovery: { ...(total['recovery'] as Json), ...OVER } })],
  ['report.total.duplicates.journal', (total) => ({ ...total, duplicates: { ...(total['duplicates'] as Json), journal: OVER } })],
  ['report.total.intervention', (total) => ({ ...total, intervention: OVER })],
  ['report.total.overrun', (total) => ({ ...total, overrun: { ...(total['overrun'] as Json), ...OVER } })],
  ['report.total.overrun.money', (total) => ({ ...total, overrun: { ...(total['overrun'] as Json), money: OVER } })],
];

describe('the decoder of a reliability file refuses a rate its readers cannot take', () => {
  it.each(RATES)('refuses %s with k above n, naming the field', (path, change) => {
    expect(() => decodeReliabilityReport(withTotal(change))).toThrow(new RegExp(`${path.replaceAll('.', '\\.')}\\.k must be at most n \\(${MIN_RATE_POPULATION}\\)`));
  });

  it.each([
    ['intervened', 'report.total.delegation.intervened'],
    ['unattended', 'report.total.delegation.unattended'],
  ])('refuses the delegation count %s above the number of mandate runs', (key, path) => {
    const text = withTotal((total) => ({ ...total, delegation: { ...(total['delegation'] as Json), n: MIN_RATE_POPULATION, [key]: MIN_RATE_POPULATION + 1 } }));
    expect(() => decodeReliabilityReport(text)).toThrow(new RegExp(`${path.replaceAll('.', '\\.')} must be at most n \\(${MIN_RATE_POPULATION}\\)`));
  });

  it('refuses the same rate inside a group', () => {
    const report = currentReport();
    const total = report['total'] as Json;
    const text = JSON.stringify({ ...report, groups: { fm: { ...total, intervention: OVER } } });
    expect(() => decodeReliabilityReport(text)).toThrow(/report\.groups\.fm\.intervention\.k must be at most n/);
  });

  it('decodes a rate with k equal to n, and the text report prints it', () => {
    const full = { k: MIN_RATE_POPULATION, n: MIN_RATE_POPULATION };
    const decoded = decodeReliabilityReport(withTotal((total) => ({ ...total, intervention: full })));
    expect(decoded.total.intervention).toEqual(full);
    expect(formatReliabilityReport(decoded)).toContain(`Human Intervention Rate: ${MIN_RATE_POPULATION}/${MIN_RATE_POPULATION} = 100.0%`);
  });
});
