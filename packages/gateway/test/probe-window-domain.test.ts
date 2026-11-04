import { describe, expect, it } from 'vitest';
import { capabilitiesFromProbe, decideToolCalling } from '@momonga/gateway';
import { MAX_BUDGET_COUNT } from '@momonga/protocol';
import { makeReport } from './report-fixture.ts';

const reportWithWindow = (value: number) => ({ ...makeReport(1, 1), contextWindow: { value, method: 'reported' as const } });

describe('a probed context window', () => {
  it('is accepted at exactly 2^33', () => {
    const report = reportWithWindow(MAX_BUDGET_COUNT);
    expect(capabilitiesFromProbe(report, decideToolCalling(report)).contextWindow).toBe(MAX_BUDGET_COUNT);
  });

  it('is refused above 2^33 with a RangeError, never computed inexactly', () => {
    const report = reportWithWindow(MAX_BUDGET_COUNT + 1);
    expect(() => capabilitiesFromProbe(report, decideToolCalling(report))).toThrow(RangeError);
  });
});
