import { describe, expect, it } from 'vitest';
import type { MessageInputItem, RunEventPayload } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { fixtureCompactionItem } from '@momonga/testkit';
import { enqueue, harness, mustClaim, newSession } from './helpers.ts';

const PLAIN: MessageInputItem = { type: 'message', role: 'user', content: '<conversation_summary>\nfirst part\n</conversation_summary>' };

const prefix: RunEventPayload[] = [
  { type: 'run.started', attempt: 1, now: 1, pins: {} },
  { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'first part'), summary: 'first part', replacedThroughSeq: 1 },
  { type: 'model.requested', step: 2, attempt: 1, digest: 'd2', body: { tool_choice: 'auto' } },
];

const foldStored = async (tail: RunEventPayload) => {
  const { store } = harness();
  const run = await enqueue(store, newSession(store).id, 'go');
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, [...prefix, tail]).kind).toBe('ok');
  const events = store.readRunEvents(run.id, 0, 1000);
  const state = events.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }));
  return { events, state };
};

describe('context.compaction_rejected decoded through the store', () => {
  it('leaves the in-flight request untouched for an event without attempt, although the envelope carries the step', async () => {
    const { events, state } = await foldStored({ type: 'context.compaction_rejected', item: PLAIN });
    const rejected = events.find((event) => event.type === 'context.compaction_rejected');
    expect(rejected?.step).toBe(2);
    expect(state.summary?.item).toEqual(PLAIN);
    expect(state.inFlightModelRequest).toMatchObject({ step: 2, attempt: 1 });
    expect(state.steps[2]).toEqual({ toolChoice: 'auto', summary: false });
  });

  it('settles the in-flight request when step and attempt match it', async () => {
    const { state } = await foldStored({ type: 'context.compaction_rejected', step: 2, attempt: 1, item: PLAIN });
    expect(state.inFlightModelRequest).toBeUndefined();
    expect(state.steps[2]).toBeUndefined();
  });

  it('leaves the in-flight request untouched when the attempt differs', async () => {
    const { state } = await foldStored({ type: 'context.compaction_rejected', step: 2, attempt: 2, item: PLAIN });
    expect(state.inFlightModelRequest).toMatchObject({ step: 2, attempt: 1 });
    expect(state.steps[2]).toEqual({ toolChoice: 'auto', summary: false });
  });
});
