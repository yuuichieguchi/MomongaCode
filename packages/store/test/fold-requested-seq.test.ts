import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { START_MS, enqueue, harness, mustClaim, newSession } from './helpers.ts';
import { roundTripped } from './run-state-codec.ts';

const IDS = { runId: 'run-1', sessionId: 'sess-1' };

const foldAll = (payloads: readonly RunEventPayload[]): RunState =>
  payloads.reduce<RunState>((state, payload, index) => {
    const step = 'step' in payload && typeof payload.step === 'number' ? payload.step : 0;
    const event = { ...payload, id: index + 1, ...IDS, seq: index + 1, step, leaseToken: 1, createdAt: START_MS } as RunEvent;
    return foldRunState(state, event);
  }, initialRunState(IDS));

const requested = (step: number): RunEventPayload => ({
  type: 'model.requested',
  step,
  attempt: 1,
  digest: `digest-${step}`,
  body: { model: 'fm', input: [], stream: true },
});

const notice = (message: string): RunEventPayload => ({ type: 'notice', level: 'info', message });

describe('fold: requestedSeq of the in-flight model request', () => {
  it('records the seq of the model.requested event on inFlightModelRequest', () => {
    const state = foldAll([notice('a'), notice('b'), notice('c'), requested(1)]);
    expect(state.inFlightModelRequest).toMatchObject({ step: 1, attempt: 1, requestedSeq: 4 });
  });

  it('records the seq of the latest request after an earlier one settled', () => {
    const state = foldAll([
      requested(1),
      { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      notice('between'),
      requested(2),
    ]);
    expect(state.inFlightModelRequest).toMatchObject({ step: 2, requestedSeq: 4 });
  });
});

describe('snapshot codec: requestedSeq', () => {
  const snapshotWith = async (patch: (state: RunState) => RunState) => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const appended = store.append(mustClaim(store, 'worker-1'), [notice('first'), requested(1)]);
    if (appended.kind !== 'ok') throw new Error('expected the append to succeed');
    const state = store.readRunEvents(run.id, 0, 100).reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }));
    return { read: () => roundTripped(patch(state)), state };
  };

  it('round-trips requestedSeq', async () => {
    const { read, state } = await snapshotWith((state) => state);
    const loaded = read();
    expect(loaded?.inFlightModelRequest).toMatchObject({ requestedSeq: 3 });
    expect(loaded).toEqual(state);
  });

  it.each([
    ['a missing requestedSeq', undefined],
    ['a string requestedSeq', '3'],
    ['a non-integer requestedSeq', 2.5],
  ])('rejects a snapshot whose in-flight request holds %s', async (_label, value) => {
    const { read } = await snapshotWith((state) => {
      const inFlight = { ...(state.inFlightModelRequest as Record<string, unknown>) };
      if (value === undefined) delete inFlight['requestedSeq'];
      else inFlight['requestedSeq'] = value;
      return { ...state, inFlightModelRequest: inFlight } as RunState;
    });
    expect(() => read()).toThrow(/does not hold a RunState/);
  });
});
