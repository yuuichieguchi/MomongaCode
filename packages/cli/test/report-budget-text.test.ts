import { describe, expect, it } from 'vitest';
import type { RunReport } from '@momonga/protocol';
import { renderReport } from '../src/commands/report.ts';

const BASE: RunReport = {
  runId: 'run-1',
  status: 'STOPPED',
  stopReason: 'budget',
  durationMs: 1200,
  declaration: null,
  changes: { files: [], mutatingCalls: 0 },
  conditions: [],
  notRun: [],
  residualRisk: [],
  modelChecks: [],
};

const DEADLINE = Date.parse('2026-11-11T06:00:00.000Z');

describe('the report text shows the budget of the run', () => {
  it('prints every limit with what was spent and reserved, the money in USD, and what stopped the run', () => {
    const text = renderReport({
      ...BASE,
      budget: {
        limits: { maxSteps: 50, maxTotalTokens: 1_000_000, maxCostNano: 4_000_000, deadlineAt: DEADLINE },
        spent: { steps: 3, totalTokens: 1200, costNano: 3_900_000, unpricedCalls: 0 },
        reserved: { tokens: 500, costNano: 20_000 },
      },
      stoppedBy: { dimension: 'cost', cause: 'cap_too_small', spent: 3_900_000, limit: 4_000_000 },
    });

    expect(text.split('\n').slice(-6)).toEqual([
      'budget (tokens and money are those of the run and its child runs):',
      '  steps  3 of 50',
      '  tokens  1200 of 1000000 (500 reserved)',
      '  money  0.0039 USD of 0.004 USD (0.00002 USD reserved)',
      '  deadline  2026-11-11T06:00:00.000Z',
      'The run stopped at its money limit: what is left does not pay for another model request (0.0039 USD of 0.004 USD used or reserved).',
    ]);
  });

  it('says no limit where none is declared, and counts the calls with no price apart from the amount', () => {
    const text = renderReport({
      ...BASE,
      status: 'COMPLETED',
      budget: { limits: { deadlineAt: DEADLINE }, spent: { steps: 1, totalTokens: 40, costNano: 0, unpricedCalls: 2 }, reserved: { tokens: 0, costNano: 0 } },
    });

    expect(text).toContain('  steps  1, no limit');
    expect(text).toContain('  tokens  40, no limit');
    expect(text).toContain('  money  0 USD, no limit; 2 calls have no price and are not in this amount');
    expect(text).not.toContain('stopped by');
  });

  it.each([
    [{ dimension: 'tokens', cause: 'limit', spent: 100, limit: 100 } as const, 'The run stopped at its token limit (100 of 100 used or reserved).'],
    [{ dimension: 'steps', cause: 'limit', spent: 5, limit: 5 } as const, 'The run stopped at its step limit (5 of 5 used or reserved).'],
    [{ dimension: 'cost', cause: 'unpriced', spent: 0, limit: 1_000_000_000 } as const, 'The run stopped at its money limit: a model call has no price, so its cost cannot be counted (0 USD of 1 USD used or reserved).'],
  ])('names the limit and the cause of %j', (stoppedBy, line) => {
    expect(renderReport({ ...BASE, stoppedBy }).split('\n').at(-1)).toBe(line);
  });
});

describe('the report text lists the held and denied calls of a mandate run', () => {
  it('prints each held call with what became of it, each denied call with why, and that the run waited with calls held', () => {
    const text = renderReport({
      ...BASE,
      status: 'COMPLETED',
      delegation: {
        held: [
          { callId: 'm1', tool: 'PullRequestMerge', reason: 'merging needs a person', heldSeq: 4, outcome: 'executed', status: 'completed', resolvedSeq: 9 },
          { callId: 'm2', tool: 'Bash', reason: 'gh pr merge is not read-only', heldSeq: 5, outcome: 'rejected', status: 'failed', resolvedSeq: 10 },
          { callId: 'm3', tool: 'Bash', reason: 'git push --force', heldSeq: 6, outcome: 'withdrawn', status: 'failed', resolvedSeq: 11 },
          { callId: 'm4', tool: 'Edit', reason: 'outside the scope', heldSeq: 7 },
        ],
        denied: [
          { callId: 'd1', tool: 'Bash', source: 'mandate', reason: 'curl is outside the mandate' },
          { callId: 'd2', tool: 'Edit', source: 'held', reason: 'the file is written by a held call' },
        ],
        quiescent: true,
      },
    });

    expect(text.split('\n').slice(-9, -1)).toEqual([
      'calls held for a person:',
      '  PullRequestMerge  approved and run, late result completed  (merging needs a person)',
      '  Bash  rejected  (gh pr merge is not read-only)',
      '  Bash  withdrawn  (git push --force)',
      '  Edit  still held  (outside the scope)',
      'calls denied under the mandate:',
      '  Bash  outside the mandate  (curl is outside the mandate)',
      '  Edit  meets a held call  (the file is written by a held call)',
    ]);
    expect(text.split('\n').at(-1)).toBe('the run finished its other work and waited for a person with calls held');
  });

  it('prints none of the sections for a run without them', () => {
    const { stopReason: _stopped, ...completed } = { ...BASE, status: 'COMPLETED' };
    const text = renderReport(completed);

    expect(text).not.toContain('budget');
    expect(text).not.toContain('held');
    expect(text).not.toContain('denied');
  });
});

describe('the report text lists the Git and Pull Request operations of the run', () => {
  it('prints each operation with its observed effect and its destination', () => {
    const text = renderReport({
      ...BASE,
      operations: [
        { callId: 'c1', operation: 'GitPush', target: 'origin refs/heads/feature', effect: 'applied' },
        { callId: 'c2', operation: 'PullRequestCreate', target: 'acme/app#7', effect: 'already_applied' },
        { callId: 'c3', operation: 'GitFetch', target: 'origin', effect: 'unknown' },
      ],
    });

    expect(text.split('\n').slice(-4)).toEqual([
      'Git and Pull Request operations (observed effect, destination):',
      '  GitPush  applied  origin refs/heads/feature',
      '  PullRequestCreate  already applied  acme/app#7',
      '  GitFetch  unknown  origin',
    ]);
  });

  it('prints no operations section for a run without one', () => {
    expect(renderReport(BASE)).not.toContain('operations');
  });
});
