import { describe, expect, it } from 'vitest';
import type { RunReport } from '@momonga/protocol';
import { resultOf } from '../src/run/headless.ts';
import type { RunView } from '../src/client/views.ts';

const REPORT: RunReport = {
  runId: 'run-1',
  status: 'STOPPED',
  stopReason: 'budget',
  durationMs: 10,
  declaration: null,
  changes: { files: [], mutatingCalls: 0 },
  conditions: [],
  notRun: [],
  residualRisk: [],
  modelChecks: [],
};

const run = (report: RunReport | undefined): RunView =>
  ({ id: 'run-1', sessionId: 'session-1', status: 'STOPPED', stopReason: 'budget', step: 3, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, costNano: 3_900_000 }, ...(report === undefined ? {} : { report }) }) as unknown as RunView;

describe('the headless result carries the budget of the run', () => {
  it('gives the limits, the spend, the reservations and what stopped the run, the money as decimal dollars', () => {
    const result = resultOf(
      run({
        ...REPORT,
        budget: {
          limits: { maxSteps: 50, maxTotalTokens: 1_000_000, maxCostNano: 4_000_000, deadlineAt: 99 },
          spent: { steps: 3, totalTokens: 1200, costNano: 3_900_000, unpricedCalls: 1 },
          reserved: { tokens: 0, costNano: 0 },
        },
        stoppedBy: { dimension: 'cost', cause: 'cap_too_small', spent: 3_900_000, limit: 4_000_000 },
      }),
      '',
    );

    expect(result.budget).toEqual({
      limits: { max_steps: 50, max_total_tokens: 1_000_000, max_cost_usd: '0.004', deadline_at: 99 },
      spent: { steps: 3, total_tokens: 1200, cost_usd: '0.0039', unpriced_calls: 1 },
      reserved: { tokens: 0, cost_usd: '0' },
      stopped_by: { dimension: 'cost', cause: 'cap_too_small', spent_usd: '0.0039', limit_usd: '0.004' },
    });
    expect(result.cost_usd).toBe('0.0039');
  });

  it('leaves out a limit that is not declared, and gives a stop on tokens or steps as counts', () => {
    const result = resultOf(
      run({
        ...REPORT,
        budget: { limits: { maxTotalTokens: 1200, deadlineAt: 99 }, spent: { steps: 3, totalTokens: 1200, costNano: 0, unpricedCalls: 0 }, reserved: { tokens: 0, costNano: 0 } },
        stoppedBy: { dimension: 'tokens', cause: 'limit', spent: 1200, limit: 1200 },
      }),
      '',
    );

    expect(result.budget).toEqual({
      limits: { max_total_tokens: 1200, deadline_at: 99 },
      spent: { steps: 3, total_tokens: 1200, cost_usd: '0', unpriced_calls: 0 },
      reserved: { tokens: 0, cost_usd: '0' },
      stopped_by: { dimension: 'tokens', cause: 'limit', spent: 1200, limit: 1200 },
    });
  });

  it('has no budget block when the run came without a report', () => {
    expect(resultOf(run(undefined), '')).not.toHaveProperty('budget');
    expect(resultOf(run(REPORT), '')).not.toHaveProperty('budget');
  });
});
