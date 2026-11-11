import { describe, expect, it } from 'vitest';
import { RELIABILITY_FORMAT } from '@momonga/protocol';
import { aggregate, buildReliabilityReport, decodeReliabilityReport, encodeReliabilityReport } from '@momonga/reliability';

describe('a reliability report of a retired format', () => {
  it('is refused with a message that names the version and says the report must be rebuilt', () => {
    expect(RELIABILITY_FORMAT).toBe('momonga-reliability/4');
    const current = JSON.parse(encodeReliabilityReport(buildReliabilityReport({ kind: 'real', aggregate: aggregate([], { groupBy: 'model' }) }))) as Record<string, unknown>;
    const old = JSON.stringify({ ...current, format: 'momonga-reliability/1' });
    expect(() => decodeReliabilityReport(old)).toThrow(
      /momonga-reliability\/1 reports do not record the tasks whose run facts hold a value the build does not know, so momonga-reliability\/1 is retired; rebuild the report/,
    );
  });

  it('refuses a momonga-reliability/3 report, which holds no money limit in the overrun and no figures of mandate runs', () => {
    const current = JSON.parse(encodeReliabilityReport(buildReliabilityReport({ kind: 'real', aggregate: aggregate([], { groupBy: 'model' }) }))) as Record<string, unknown>;
    expect(() => decodeReliabilityReport(JSON.stringify({ ...current, format: 'momonga-reliability/3' }))).toThrow(
      /momonga-reliability\/3 reports do not record the money limit in the budget overrun and the figures of mandate runs, so momonga-reliability\/3 is retired; rebuild the report/,
    );
  });
});
