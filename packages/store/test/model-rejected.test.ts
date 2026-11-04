import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { decodeEvent } from '../src/codec.ts';
import { START_MS } from './helpers.ts';

const IDS = { runId: 'run-1', sessionId: 'sess-1' };

const foldAll = (payloads: readonly RunEventPayload[]): RunState =>
  payloads.reduce<RunState>((state, payload, index) => {
    const step = 'step' in payload && typeof payload.step === 'number' ? payload.step : 0;
    const event = { ...payload, id: index + 1, ...IDS, seq: index + 1, step, leaseToken: 1, createdAt: START_MS } as RunEvent;
    return foldRunState(state, event);
  }, initialRunState(IDS));

const BODY = { model: 'fm', input: [], stream: true };

const requested = (step: number): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: `digest-${step}`, body: BODY });

const rejected = (step: number, attempt: number): RunEventPayload => ({
  type: 'model.rejected',
  step,
  attempt,
  reason: 'counter_mismatch',
  counter: 'b'.repeat(64),
  meterCounter: 'a'.repeat(64),
});

const charged: RunEventPayload = {
  type: 'usage.charged',
  purpose: 'rejected_answer',
  inputTokens: 300,
  outputTokens: 7,
  totalTokens: 307,
  responseId: 'resp_rejected',
  cachedInputTokens: 20,
};

const responded = (step: number, attempt: number): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt,
  response: { status: 'completed', output: [], usage: { input_tokens: 310, output_tokens: 5, total_tokens: 315 } },
});

const ENVELOPE = { id: 9, runId: 'r1', sessionId: 's1', seq: 5, step: 1, leaseToken: 1, createdAt: 10 };

const row = (payload: RunEventPayload): never =>
  ({
    id: ENVELOPE.id,
    run_id: ENVELOPE.runId,
    session_id: ENVELOPE.sessionId,
    seq: ENVELOPE.seq,
    step: ENVELOPE.step,
    lease_token: ENVELOPE.leaseToken,
    created_at: ENVELOPE.createdAt,
    type: payload.type,
    payload_json: JSON.stringify(payload),
  }) as never;

describe('model.rejected and the rejected_answer charge in the journal codec', () => {
  it('decodes model.rejected', () => {
    expect(decodeEvent(row(rejected(1, 1)))).toEqual({ ...rejected(1, 1), ...ENVELOPE });
  });

  it('decodes a usage.charged of the purpose rejected_answer', () => {
    expect(decodeEvent(row(charged))).toEqual({ ...charged, ...ENVELOPE });
  });
});

describe('the fold of model.rejected', () => {
  it('keeps the in-flight request and raises its attempt when step and attempt match', () => {
    const state = foldAll([requested(1), rejected(1, 1)]);
    expect(state.inFlightModelRequest).toMatchObject({ step: 1, attempt: 2, digest: 'digest-1', body: BODY, requestedSeq: 1 });
  });

  it('raises the attempt again after a second rejection of the next attempt', () => {
    const state = foldAll([requested(1), rejected(1, 1), rejected(1, 2)]);
    expect(state.inFlightModelRequest).toMatchObject({ step: 1, attempt: 3 });
  });

  it.each([
    ['another step', rejected(2, 1)],
    ['another attempt', rejected(1, 2)],
  ])('leaves the in-flight request unchanged for a rejection of %s', (_label, event) => {
    const state = foldAll([requested(1), event]);
    expect(state.inFlightModelRequest).toMatchObject({ step: 1, attempt: 1, requestedSeq: 1 });
  });

  it('is cleared by the model.responded of the raised attempt', () => {
    const state = foldAll([requested(1), rejected(1, 1), responded(1, 2)]);
    expect(state.inFlightModelRequest).toBeUndefined();
  });

  it('adds the rejected answer to the running usage once, beside the accepted answer', () => {
    const state = foldAll([requested(1), rejected(1, 1), charged, responded(1, 2)]);
    expect(state.usage).toMatchObject({ inputTokens: 610, outputTokens: 12, totalTokens: 622 });
  });
});
