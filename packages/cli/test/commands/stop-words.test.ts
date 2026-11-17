import type { RunReport } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { renderReport } from '../../src/commands/report.ts';

const BASE: RunReport = {
  runId: 'run-1',
  status: 'STOPPED',
  stopReason: 'max_steps',
  durationMs: 1200,
  declaration: null,
  changes: { files: [], mutatingCalls: 0 },
  conditions: [],
  notRun: [],
  residualRisk: [],
  modelChecks: [],
};

describe('the report prints the word of a stop reason and of a not-run reason, not the identifier', () => {
  it('prints the word of the stop reason in the outcome line', () => {
    expect(renderReport(BASE).split('\n')[0]).toBe('run run-1: STOPPED (step limit reached), 1200 ms');
  });

  it('prints the word of the reason of each run that was not run', () => {
    const text = renderReport({ ...BASE, notRun: [{ what: 'the review step', reason: 'budget' }] });
    expect(text.split('\n')).toContain('  the review step  (the budget limit was reached)');
    expect(text).not.toContain('(budget)');
  });
});
