import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { SNAPSHOT_STATE_VERSION } from '../src/codec.ts';
import { fixtureCompactionItem } from '@momonga/testkit';
import { enqueue, harness, mustClaim, newSession } from './helpers.ts';
import { encodedRunState, foldedRunState } from './run-state-codec.ts';
import { assistantItem, inheritedEvent, taskItem } from './inherit-fixtures.ts';
import { TEST_FENCE } from '@momonga/testkit';

const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const PLAIN = { type: 'message', role: 'user', content: '<conversation_summary>\nfirst part\n</conversation_summary>' } as const;

const journal: RunEventPayload[] = [
  { type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm' }, mode: 'plan' },
  { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { tool_choice: 'auto' } },
  {
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: { status: 'completed', output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: USAGE },
  },
  { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'first part'), summary: 'first part', replacedThroughSeq: 3 },
  { type: 'context.compaction_rejected', item: PLAIN },
  { type: 'model.requested', step: 2, attempt: 1, digest: 'd2', body: { tool_choice: 'auto' } },
  { type: 'agent.message.delta', step: 2, attempt: 1, itemId: 'm2', text: 'partial answer' },
  { type: 'agent.thought.delta', step: 2, attempt: 1, itemId: 'r2', text: 'reasoning' },
];

const INHERITED = inheritedEvent({
  fromRunId: 'run-prev',
  fromLastSeq: 7,
  history: [
    { seq: 1, item: taskItem('earlier question') },
    { seq: 2, item: assistantItem('m0', 'earlier answer') },
  ],
  nextItemSeq: 3,
  mode: 'plan',
});

const storedSnapshot = async (leading: readonly RunEventPayload[] = []) => {
  const { store } = harness();
  const run = await enqueue(store, newSession(store).id, 'continue the work');
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, [...leading, ...journal]).kind).toBe('ok');
  const events: RunEvent[] = store.readRunEvents(run.id, 0, 1000);
  const state = events.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId, fence: store.getSession(run.sessionId)?.fenceNonce ?? '' }));
  const encoded = encodedRunState(state);
  return { store, run, state, events, mutate: encoded.mutate, storedJson: encoded.json, read: encoded.read };
};

const CALL: RunEventPayload = { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Write', kind: 'edit', title: 'Write', rawInput: {} };

const classifiedWithoutDigest = { type: 'tool.permission.classified', callId: 'c1', outcome: 'allow' } as unknown as RunEventPayload;

describe('snapshot state version 11', () => {
  it('writes the current stateVersion', async () => {
    const { storedJson } = await storedSnapshot();
    expect(storedJson()['stateVersion']).toBe(SNAPSHOT_STATE_VERSION);
  });

  it('reports a snapshot without the working facts as corrupt', async () => {
    const { mutate, read } = await storedSnapshot();
    mutate("json_remove(state_json, '$.workingFacts')");
    expect(() => read()).toThrow(/corrupt/);
  });

  it('treats a version 9 snapshot as absent and rebuilds it from the journal', async () => {
    const { store, run, state, mutate, read } = await storedSnapshot();
    mutate("json_set(state_json, '$.stateVersion', 9)");
    expect(read()).toBeUndefined();
    expect(await foldedRunState(store, run.id)).toEqual(state);
  });

  it('treats a version 15 snapshot, the last that carried the touched list, as absent and rebuilds a state without it', async () => {
    const { store, run, state, mutate, read } = await storedSnapshot();
    mutate("json_set(json_set(state_json, '$.stateVersion', 15), '$.workingFacts.touched', json('[{\"kind\":\"file\",\"path\":\"/work/a/x.ts\"}]'))");
    expect(read()).toBeUndefined();
    const rebuilt = await foldedRunState(store, run.id);
    expect(rebuilt).toEqual(state);
    expect(rebuilt.workingFacts).not.toHaveProperty('touched');
  });

  it('folds a classification journaled without a subject digest into no classification, so the snapshot stays readable', async () => {
    const { state, read } = await storedSnapshot([CALL, classifiedWithoutDigest]);
    expect(state.pendingCalls['c1']).toBeDefined();
    expect(state.pendingCalls['c1']).not.toHaveProperty('classification');
    expect(read()).toEqual(state);
  });

  it('round-trips taskSeq and inherited for an inheriting run', async () => {
    const { run, state, storedJson, read } = await storedSnapshot([INHERITED]);
    expect(state.taskSeq).toBe(3);
    expect(state.inherited).toEqual({ fromRunId: 'run-prev', fromLastSeq: 7, digest: INHERITED.digest });
    expect(storedJson()['taskSeq']).toBe(3);
    expect(read()).toEqual(state);
  });

  it('treats a version 6 snapshot of an inheriting run as absent and replays the event from the journal', async () => {
    const { store, run, state, mutate, read } = await storedSnapshot([INHERITED]);
    mutate("json_set(state_json, '$.stateVersion', 6)");
    expect(read()).toBeUndefined();
    expect(await foldedRunState(store, run.id)).toEqual(state);
  });

  it('round-trips streaming with seen, its thought ids, the mode and a plain-message summary', async () => {
    const { state, read } = await storedSnapshot();
    expect(state.mode).toBe('plan');
    expect(state.streaming).toEqual({ step: 2, attempt: 1, seen: true, items: [{ itemId: 'm2', text: 'partial answer' }], thoughtIds: ['r2'] });
    expect(state.summary).toEqual({ item: PLAIN, summary: 'first part', replacedThroughSeq: 3 });
    expect(read()).toEqual(state);
  });

  it('treats an otherwise valid version 6 snapshot as absent and falls back to the full fold', async () => {
    const { store, run, state, mutate, read } = await storedSnapshot();
    mutate("json_set(state_json, '$.stateVersion', 6)");
    expect(read()).toBeUndefined();
    expect(await foldedRunState(store, run.id)).toEqual(state);
  });

  it.each([
    ['a streaming record whose seen is not a boolean', "json_set(state_json, '$.streaming.seen', 'yes')"],
    ['a streaming item whose text is not a string', "json_set(state_json, '$.streaming.items[0].text', 7)"],
    ['a streaming record without a step', "json_remove(state_json, '$.streaming.step')"],
    ['an unknown mode', "json_set(state_json, '$.mode', 'yolo')"],
    ['a plain-message summary whose role is not user', "json_set(state_json, '$.summary.item.role', 'assistant')"],
    ['a plain-message summary without string content', "json_set(state_json, '$.summary.item.content', 3)"],
  ])('reports a snapshot with %s as corrupt', async (_label, expression) => {
    const { mutate, read } = await storedSnapshot();
    mutate(expression);
    expect(() => read()).toThrow(/corrupt/);
  });

  it.each([
    ['a taskSeq that is not an integer', "json_set(state_json, '$.taskSeq', 'one')"],
    ['no taskSeq', "json_remove(state_json, '$.taskSeq')"],
    ['an inherited record without a digest', "json_remove(state_json, '$.inherited.digest')"],
    ['an inherited record whose fromLastSeq is not an integer', "json_set(state_json, '$.inherited.fromLastSeq', 'seven')"],
    ['an inherited record whose fromRunId is not a string', "json_set(state_json, '$.inherited.fromRunId', 3)"],
  ])('reports an inheriting snapshot with %s as corrupt', async (_label, expression) => {
    const { mutate, read } = await storedSnapshot([INHERITED]);
    mutate(expression);
    expect(() => read()).toThrow(/corrupt/);
  });
});
