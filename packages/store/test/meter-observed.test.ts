import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { decodeEvent } from '../src/codec.ts';
import { foldOf, task } from './inherit-fixtures.ts';

const ENVELOPE = { id: 9, runId: 'r1', sessionId: 's1', seq: 5, step: 1, leaseToken: 1, createdAt: 10 };

const OBSERVED: RunEventPayload = {
  type: 'meter.observed',
  target: 'primary',
  counter: 'c'.repeat(64),
  fallback: false,
  inputDigest: 'd'.repeat(64),
  itemCount: 3,
  counted: 250,
  reported: 240,
  kept: 250,
  known: 200,
  uncounted: 50,
  miss: 5,
  contextWindow: 8192,
  tokenCounting: 'estimated',
};

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

describe('meter.observed in the journal', () => {
  it('decodes', () => {
    expect(decodeEvent(row(OBSERVED))).toEqual({ ...OBSERVED, ...ENVELOPE });
  });

  it('leaves the run state unchanged, since only the meter folds it', () => {
    const unchanged: RunEventPayload = { type: 'usage.updated', inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    expect(foldOf([task('count'), OBSERVED])).toEqual(foldOf([task('count'), unchanged]));
  });
});
