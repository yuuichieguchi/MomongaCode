import { RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { stopReasonOf } from '../src/acp/stop-reason.ts';
import { runView } from './fake-backend.ts';

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
    expect(failure).toMatchObject({ code: -32603, data: { runId: 'run-9', status: 'STOPPED', stopReason } });
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
