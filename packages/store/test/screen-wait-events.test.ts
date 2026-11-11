import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { decodeEvent } from '../src/codec.ts';
import { ENVELOPE_KEYS, enqueue, harness, mustClaim, mustRun, newSession, payloadOf } from './helpers.ts';

const COMPACTING: RunEventPayload = { type: 'context.compacting', step: 0, attempt: 1 };
const CLASSIFYING: RunEventPayload = { type: 'tool.permission.classifying', callId: 'call-1', subjectDigest: 'd'.repeat(64) };
const HOOK_STARTED: RunEventPayload = { type: 'hook.started', event: 'PreToolUse', command: 'echo checked', callId: 'call-1' };
const LIFECYCLE_HOOK_STARTED: RunEventPayload = { type: 'hook.started', event: 'Stop', command: 'echo bye' };

const PAYLOADS = [COMPACTING, CLASSIFYING, HOOK_STARTED, LIFECYCLE_HOOK_STARTED];

const ENVELOPE = { id: 9, runId: 'r1', sessionId: 's1', seq: 5, step: 0, leaseToken: 1, createdAt: 10 };

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

describe('the run events that back the waiting row in the journal (design-screens 6.1.1)', () => {
  it.each(PAYLOADS)('the codec decodes $type as a known run event', (payload) => {
    expect(decodeEvent(row(payload))).toEqual({ ...payload, ...ENVELOPE });
  });

  it('the store writes them to the journal of a run and reads them back unchanged, in order', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'worker-1');

    expect(store.append(claim, PAYLOADS).kind).toBe('ok');

    const read = store.readRunEvents(run.id, 0, 100).filter((event) => PAYLOADS.some((payload) => payload.type === event.type));
    expect(read.map((event) => ({ ...payloadOf(event), ...(event.type === 'context.compacting' ? { step: event.step } : {}) }))).toEqual(PAYLOADS);
    for (const event of read) expect(Object.keys(event)).toEqual(expect.arrayContaining([...ENVELOPE_KEYS]));
  });

  it('a compaction that starts does not advance the step of its run', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'worker-1');
    const before = mustRun(store, run.id).step;

    expect(store.append(claim, [{ type: 'context.compacting', step: before, attempt: 1 }]).kind).toBe('ok');

    expect(mustRun(store, run.id).step).toBe(before);
  });

  it.each(PAYLOADS)('folding $type changes nothing of the run state but its last sequence number', (payload) => {
    const state = initialRunState({ runId: ENVELOPE.runId, sessionId: ENVELOPE.sessionId });
    const event = { ...payload, ...ENVELOPE } as RunEvent;
    expect(foldRunState(state, event)).toEqual({ ...state, lastSeq: ENVELOPE.seq });
  });
});
