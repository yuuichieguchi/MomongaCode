import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { completedOutput, holdsEntry, invariantEntry, invariantViolationOutput } from './fixtures.ts';
import { measurementOf, recordProblems, recordedRow } from './record.ts';
import { specIdentityOf } from './reuse.ts';
import { readManifest } from './manifest-reader.ts';
import type { ManifestEntry } from './manifest-reader.ts';

const TIME = '        1.25 real         2.00 user         0.50 sys';
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

const coldLog = (distinct: number): string => [completedOutput(distinct), TIME].join('\n');

describe('the measurement of a cold TLC run', () => {
  it('reads the distinct states, the wall time and the CPU time of the log', () => {
    expect(measurementOf(coldLog(3))).toEqual({ distinctStates: 3, measuredSeconds: 1.25, measuredCpuSeconds: 2.5 });
  });

  it('takes the last state count of the log', () => {
    const log = [completedOutput(3), '2 states generated, 1,234 distinct states found, 0 states left on queue.', TIME].join('\n');
    expect(measurementOf(log).distinctStates).toBe(1234);
  });

  it('subtracts the wait for the run lock from the wall time', () => {
    const log = ['run-lock: heavy run starts after waiting 1.00 s', coldLog(3)].join('\n');
    expect(measurementOf(log).measuredSeconds).toBe(0.25);
  });

  it('refuses a log without the time line or without a state count', () => {
    expect(() => measurementOf(completedOutput(3))).toThrow('no /usr/bin/time -l line');
    expect(() => measurementOf(TIME)).toThrow('no TLC state count');
  });
});

describe('the verdict a recorded run must give', () => {
  it('accepts a holds row whose log completes with the recorded state count', () => {
    const log = coldLog(3);
    expect(recordProblems(holdsEntry, log, measurementOf(log))).toEqual([]);
  });

  it('refuses a holds row whose log shows a violation', () => {
    const log = [invariantViolationOutput('Small'), TIME, '3 states generated, 3 distinct states found, 0 states left on queue.'].join('\n');
    expect(recordProblems(holdsEntry, log, measurementOf(log))).not.toEqual([]);
  });

  it('accepts an evidence row whose log shows its expected violation', () => {
    const log = [invariantViolationOutput('Small'), TIME, '3 states generated, 3 distinct states found, 0 states left on queue.'].join('\n');
    expect(recordProblems(invariantEntry, log, measurementOf(log))).toEqual([]);
  });
});

describe('the row a recorded run writes', () => {
  it('stores the numbers, the budget and the identity of the spec as measured', async () => {
    const row = readManifest(path.join(repoRoot, 'specs', 'tla', 'manifest.json')).entries.find((entry) => entry.config === 'StopProtocol') as ManifestEntry;
    const recorded = await recordedRow(repoRoot, row, coldLog(16556), 3, '5.83');
    expect(recorded).toMatchObject({
      config: 'StopProtocol',
      distinctStates: 16556,
      measuredSeconds: 1.25,
      measuredCpuSeconds: 2.5,
      measuredReuse: 'off',
      budgetCpuSeconds: 8,
      identity: await specIdentityOf(repoRoot, row),
    });
  });
});
