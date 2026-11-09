import { describe, expect, it } from 'vitest';
import { RELIABILITY_FORMAT } from '@momonga/protocol';
import {
  aggregate,
  buildReliabilityReport,
  decodeReliabilityReport,
  describeRate,
  encodeReliabilityReport,
  foldFacts,
  formatReliabilityReport,
} from '@momonga/reliability';
import type { RunFacts } from '@momonga/reliability';
import { T0, attemptLost, eventsOf, modelResponded, reconciled, runInfo, started, status, terminal, toolCall, toolStarted } from './streams.ts';

const task = (index: number, declared: boolean, met: boolean): RunFacts => {
  const runId = `r${index}`;
  const status = met ? 'COMPLETED' : 'FAILED';
  return foldFacts(
    eventsOf(runId, [
      [T0, started(1, { declared })],
      [T0 + 100, terminal(status)],
    ]),
    runInfo({ runId, status }),
  );
};

const tasks = (declaredMet: number, declaredUnmet: number, undeclared: number): RunFacts[] => [
  ...Array.from({ length: declaredMet }, (_, index) => task(index, true, true)),
  ...Array.from({ length: declaredUnmet }, (_, index) => task(1000 + index, true, false)),
  ...Array.from({ length: undeclared }, (_, index) => task(2000 + index, false, true)),
];

const reportOf = (rows: readonly RunFacts[]) => buildReliabilityReport({ kind: 'real', aggregate: aggregate(rows, { groupBy: 'model' }) });

const lineWith = (text: string, label: string): string => {
  const line = text.split('\n').find((candidate) => candidate.includes(label));
  if (line === undefined) throw new Error(`the report has no line with "${label}":\n${text}`);
  return line;
};

describe('rates are printed as k/n with the Wilson interval, and as counts only below 35', () => {
  it('prints k/n = p (95% Wilson low..high) at n >= 35', () => {
    expect(describeRate({ k: 12, n: 40 })).toBe('12/40 = 30.0% (95% Wilson 18.1%..45.4%)');
    expect(describeRate({ k: 35, n: 35 })).toBe('35/35 = 100.0% (95% Wilson 90.1%..100.0%)');
    expect(describeRate({ k: 0, n: 35 })).toBe('0/35 = 0.0% (95% Wilson 0.0%..9.9%)');
  });

  it('prints counts only below MIN_RATE_POPULATION', () => {
    expect(describeRate({ k: 34, n: 34 })).toBe('34/34');
    expect(describeRate({ k: 3, n: 10 })).toBe('3/10');
    expect(describeRate({ k: 0, n: 1 })).toBe('0/1');
  });
});

describe('formatReliabilityReport', () => {
  it('prints the Task Completion Rate with its interval from 40 declared tasks and leaves the 5 undeclared ones out', () => {
    const text = formatReliabilityReport(reportOf(tasks(12, 28, 5)));
    expect(lineWith(text, 'Task Completion Rate')).toContain('12/40 = 30.0% (95% Wilson 18.1%..45.4%)');
  });

  it('prints no percentage on a line whose population is below 35', () => {
    const line = lineWith(formatReliabilityReport(reportOf(tasks(34, 0, 0))), 'Task Completion Rate');
    expect(line).toContain('34/34');
    expect(line).not.toContain('%');
    expect(line).not.toContain('Wilson');
  });

  it('says not measurable when no task declared a completion condition, and never falls back to COMPLETED', () => {
    const line = lineWith(formatReliabilityReport(reportOf(tasks(0, 0, 40))), 'Task Completion Rate');
    expect(line).toContain('not measurable: no task declared a completion condition');
    expect(line).not.toContain('40/40');
    expect(line).not.toContain('%');
  });

  it('names each indicator of the strategy', () => {
    const text = formatReliabilityReport(reportOf(tasks(1, 1, 1)));
    for (const label of [
      'Task Completion Rate',
      'Recovery Success Rate',
      'Duplicate Side Effect Rate',
      'Human Intervention Rate',
      'Budget Overrun Rate',
      'Mean Recovery Time',
      'Time per Successful Task',
    ]) {
      expect(text).toContain(label);
    }
  });
});

const stoppedEpisode = (runId: string): RunFacts =>
  foldFacts(
    eventsOf(runId, [
      [T0, started(1)],
      [T0 + 100, attemptLost(T0 + 50)],
      [T0 + 110, status('RUNNING', 'STOPPED')],
    ]),
    runInfo({ runId, status: 'STOPPED', stopReason: 'timeout' }),
  );

const unknownEpisode = (runId: string): RunFacts =>
  foldFacts(
    eventsOf(runId, [
      [T0, started(1)],
      [T0 + 10, toolCall('c1', 'write')],
      [T0 + 20, toolStarted('c1')],
      [T0 + 100, attemptLost(T0 + 50)],
      [T0 + 110, started(2)],
      [T0 + 120, reconciled('c1', 'unknown')],
      [T0 + 130, modelResponded(1)],
      [T0 + 140, terminal('COMPLETED')],
    ]),
    runInfo({ runId }),
  );

describe('the Recovery Success Rate line (decisions 19 and 36)', () => {
  it('prints unknown_effect and stopped as their own counts beside the rate, outside its numerator and, for stopped, its denominator', () => {
    const line = lineWith(formatReliabilityReport(reportOf([stoppedEpisode('s1'), stoppedEpisode('s2'), unknownEpisode('u1')])), 'Recovery Success Rate');
    expect(line).toBe('Recovery Success Rate: 0/1; unknown_effect 1; failed 0; stopped 2');
  });

  it('round-trips the stopped count through momonga-reliability/2', () => {
    const report = reportOf([stoppedEpisode('s1')]);
    expect(report.total.recovery).toEqual({ k: 0, n: 0, unknownEffect: 0, failed: 0, stopped: 1 });
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
  });
});

describe('momonga-reliability/2', () => {
  it('round-trips a report through encode and decode', () => {
    const report = reportOf(tasks(12, 28, 5));
    expect(report.format).toBe(RELIABILITY_FORMAT);
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
  });

  it('refuses a retired or foreign format by name', () => {
    const encoded = JSON.parse(encodeReliabilityReport(reportOf(tasks(1, 0, 0)))) as Record<string, unknown>;
    expect(() => decodeReliabilityReport(JSON.stringify({ ...encoded, format: 'momonga-reliability/0' }))).toThrow('momonga-reliability/0');
    expect(() => decodeReliabilityReport(JSON.stringify({ ...encoded, format: 'momonga-eval/1' }))).toThrow('momonga-eval/1');
  });
});

describe('decision 55: facts_unavailable in the population line', () => {
  it('prints the unavailable roots beside the buckets and counts them as resolved in the coverage', () => {
    const report = buildReliabilityReport({ kind: 'real', aggregate: aggregate(tasks(2, 0, 0), { groupBy: 'model', unavailableRoots: ['ghost'] }) });
    expect(formatReliabilityReport(report)).toContain(
      'Population: 3 terminal root tasks; counted 2; cancelled 0 (excluded); pending facts 0 (excluded); facts unavailable 1 (excluded); unknown values 0 (excluded); facts coverage 3/3',
    );
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
  });
});
