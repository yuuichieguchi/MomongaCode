import { RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { BudgetExhausted, RunReport } from '@momonga/protocol';
import { BUDGET_EXHAUSTED_CODE, RUN_STOPPED_CODE, stopReasonOf } from '../src/acp/stop-reason.ts';
import type { RunView } from '../src/client/views.ts';
import { runView } from './fake-backend.ts';

const stoppedBy = (dimension: BudgetExhausted['dimension'], cause: BudgetExhausted['cause'] = 'limit'): RunView =>
  runView({ id: 'run-9', status: 'STOPPED', stopReason: 'budget', report: { stoppedBy: { dimension, cause, spent: 500_000_000, limit: 500_000_000 } } as unknown as RunReport });

const failureOf = (run: RunView): unknown => {
  try {
    return stopReasonOf(run);
  } catch (error) {
    return error;
  }
};

describe('the end of a run that a budget stopped', () => {
  it.each([
    ['tokens', 'max_tokens'],
    ['steps', 'max_turn_requests'],
  ] as const)('gives the ACP stop reason of the dimension: %s is %s', (dimension, expected) => {
    expect(stopReasonOf(stoppedBy(dimension))).toBe(expected);
  });

  it('is max_tokens when no dimension of the budget stopped it: the context of the session did not fit the model', () => {
    expect(stopReasonOf(runView({ status: 'STOPPED', stopReason: 'budget' }))).toBe('max_tokens');
  });

  it.each([
    ['cost', 'money'],
    ['time', 'time'],
    ['retries', 'retry'],
  ] as const)('fails the prompt with the product code of an exhausted budget when the dimension is %s, which ACP has no stop reason for', (dimension, word) => {
    const failure = failureOf(stoppedBy(dimension));

    expect(failure).toBeInstanceOf(RequestError);
    expect(failure).toMatchObject({
      code: RUN_STOPPED_CODE,
      data: { runId: 'run-9', status: 'STOPPED', stopReason: 'budget', code: BUDGET_EXHAUSTED_CODE, budget: { dimension, cause: 'limit', spent: 500_000_000, limit: 500_000_000 } },
    });
    expect((failure as Error).message).toContain(`run run-9 stopped by the ${word}`);
  });

  it('says in the failure why the money ran out and how much was used', () => {
    expect((failureOf(stoppedBy('cost', 'unpriced')) as Error).message).toBe('run run-9 stopped by the money limit: a model call has no price, so its cost cannot be counted (0.5 USD of 0.5 USD used or reserved)');
  });
});

describe('stopReasonOf', () => {
  it.each([
    [{ status: 'COMPLETED' }, 'end_turn'],
    [{ status: 'CANCELLED' }, 'cancelled'],
    [{ status: 'STOPPED', stopReason: 'max_steps' }, 'max_turn_requests'],
    [{ status: 'STOPPED', stopReason: 'max_tokens' }, 'max_tokens'],
    [{ status: 'STOPPED', stopReason: 'budget' }, 'max_tokens'],
    [{ status: 'STOPPED', stopReason: 'refusal' }, 'refusal'],
  ] as const)('maps %j to %s', (run, expected) => {
    expect(stopReasonOf(runView(run))).toBe(expected);
  });

  it.each(['timeout', 'loop', 'approval_timeout'] as const)('fails the prompt with the stop reason %s because ACP has no stop reason for it', (stopReason) => {
    const run = runView({ id: 'run-9', status: 'STOPPED', stopReason });

    const failure = (() => {
      try {
        return stopReasonOf(run);
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toBeInstanceOf(RequestError);
    expect(failure).toMatchObject({ code: RUN_STOPPED_CODE, data: { runId: 'run-9', status: 'STOPPED', stopReason } });
    expect((failure as Error).message).toContain(`stopped: ${stopReason}`);
  });

  it('fails the prompt with the error of a failed run', () => {
    const run = runView({ id: 'run-9', status: 'FAILED', error: { code: 'model_failed', message: 'the model call failed' } });

    expect(() => stopReasonOf(run)).toThrow(/run run-9 failed: model_failed: the model call failed/);
    try {
      stopReasonOf(run);
    } catch (error) {
      expect(error).toMatchObject({ code: -32603, data: { runId: 'run-9', status: 'FAILED', error: { code: 'model_failed' } } });
    }
  });

  it('refuses a stopped run that carries no stop reason and a run that has not ended', () => {
    expect(() => stopReasonOf(runView({ status: 'STOPPED' }))).toThrow('is STOPPED without a stop reason');
    for (const status of ['QUEUED', 'RUNNING', 'WAITING_TOOL', 'WAITING_HUMAN', 'CANCELLING'] as const) {
      expect(() => stopReasonOf(runView({ status }))).toThrow(`is ${status}, which is not a terminal status`);
    }
  });
});
