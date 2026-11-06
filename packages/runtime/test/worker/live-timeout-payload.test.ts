import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { FIXTURE_RUN_ID, FIXTURE_SESSION_ID, materializeEvents } from '@momonga/testkit';
import { outcomePayloads } from '../../src/worker/tool-step.ts';
import { expectSchema } from '../service/helpers.ts';

type Outcome = Parameters<typeof outcomePayloads>[0];

const liveOutcome = (reconciled: 'already_applied' | 'not_applied' | 'unknown', interrupted: 'timeout' | 'cancelled', command?: string): Outcome =>
  ({
    callId: 'c1',
    kind: 'result',
    idemKey: 'k1',
    reconciled,
    interrupted,
    result: { status: reconciled === 'already_applied' ? 'completed' : 'failed', output: 'Bash timed out after 30 ms. Its side effects are unknown; inspect the current state before retrying.', ...(command === undefined ? {} : { command }) },
  }) as unknown as Outcome;

const publicEvent = (payload: Record<string, unknown>): Record<string, unknown> => ({
  id: 1,
  runId: 'run-1',
  sessionId: 'session-1',
  seq: 5,
  step: 1,
  createdAt: 1_800_000_000_000,
  ...payload,
});

describe('the journal record of a live timeout', () => {
  it.each(['unknown', 'already_applied', 'not_applied'] as const)('journals a live %s settle as tool.reconciled carrying interrupted', (reconciled) => {
    const [settled] = outcomePayloads(liveOutcome(reconciled, 'timeout'));
    expect(settled).toEqual({
      type: 'tool.reconciled',
      callId: 'c1',
      outcome: reconciled,
      interrupted: 'timeout',
      output: 'Bash timed out after 30 ms. Its side effects are unknown; inspect the current state before retrying.',
    });
  });

  it('keeps the cancel distinct from the timeout', () => {
    const [settled] = outcomePayloads(liveOutcome('unknown', 'cancelled'));
    expect(settled).toMatchObject({ type: 'tool.reconciled', outcome: 'unknown', interrupted: 'cancelled' });
  });

  it('writes no interrupted field on a recovery settle, so older events keep their shape', () => {
    const [settled] = outcomePayloads({ callId: 'c1', kind: 'result', idemKey: 'k1', reconciled: 'unknown', result: { status: 'failed', output: 'x' } } as unknown as Outcome);
    expect(settled).toEqual({ type: 'tool.reconciled', callId: 'c1', outcome: 'unknown', output: 'x' });
  });

  it('accepts interrupted timeout and cancelled in the public event schema and rejects any other value', () => {
    for (const interrupted of ['timeout', 'cancelled']) {
      expectSchema('PublicRunEvent', publicEvent({ type: 'tool.reconciled', callId: 'c1', outcome: 'unknown', output: 'x', interrupted }));
    }
    expect(() => expectSchema('PublicRunEvent', publicEvent({ type: 'tool.reconciled', callId: 'c1', outcome: 'unknown', output: 'x', interrupted: 'crashed' }))).toThrow();
    expectSchema('PublicRunEvent', publicEvent({ type: 'tool.reconciled', callId: 'c1', outcome: 'unknown', output: 'x' }));
  });

  it('folds a live timeout of Bash into the working fact of an interrupted command with reconciled unknown', () => {
    const input = { command: 'npm test' };
    const payloads = [
      { type: 'user.message', text: 'run the tests' },
      { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: {} },
      {
        type: 'model.responded',
        step: 1,
        attempt: 1,
        response: {
          status: 'completed',
          output: [{ type: 'function_call', id: 'fc-c1', call_id: 'c1', name: 'Bash', arguments: JSON.stringify(input) }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
      { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'npm test', rawInput: input },
      { type: 'tool.started', callId: 'c1', idemKey: 'k1' },
      ...outcomePayloads(liveOutcome('unknown', 'timeout', 'npm test')),
    ] as RunEventPayload[];
    const events = materializeEvents(payloads);
    const state = events.reduce(foldRunState, initialRunState({ runId: FIXTURE_RUN_ID, sessionId: FIXTURE_SESSION_ID }));
    expect(state.workingFacts.commands).toEqual([{ command: 'npm test', failed: false, reconciled: 'unknown', seq: 6 }]);
  });
});
