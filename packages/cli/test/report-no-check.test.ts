import { describe, expect, it } from 'vitest';
import type { RunReport } from '@momonga/protocol';
import { renderReport } from '../src/commands/report.ts';

const UNDECLARED: RunReport = {
  runId: 'run-1',
  status: 'COMPLETED',
  durationMs: 1200,
  declaration: null,
  changes: { files: [{ path: 'src/a.ts', lastSeq: 3 }], mutatingCalls: 1 },
  conditions: [],
  notRun: [],
  residualRisk: [{ code: 'no_condition_declared_after_mutation', count: 1 }],
  modelChecks: [],
};

describe('the report of a run with no declared check', () => {
  it('names how to declare a check, in the line of the declaration and in the residual risk', () => {
    const lines = renderReport(UNDECLARED).split('\n');
    const named = lines.filter((line) => line.includes('verification.commands') && line.includes('terminal UI proposes'));
    expect(named).toHaveLength(2);
  });
});
