import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { fixtureCompactionItem } from '@momonga/testkit';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';
import { assistantItem, inheritedEvent, taskItem } from './inherit-fixtures.ts';

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

const storedSnapshot = (leading: readonly RunEventPayload[] = []) => {
  const { dbPath, store } = harness();
  const run = enqueue(store, newSession(store).id, 'continue the work');
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, [...leading, ...journal]).kind).toBe('ok');
  const events: RunEvent[] = store.readRunEvents(run.id, 0, 1000);
  const state = events.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }));
  const lastSeq = events[events.length - 1]!.seq;
  expect(store.writeSnapshot(claim, lastSeq, state)).toEqual({ kind: 'ok' });
  const db = rawDb(dbPath);
  const mutate = (expression: string): void => {
    db.prepare(`UPDATE snapshots SET state_json = ${expression} WHERE run_id = ?`).run(run.id);
  };
  const storedJson = (): Record<string, unknown> =>
    JSON.parse((db.prepare('SELECT state_json FROM snapshots WHERE run_id = ?').get(run.id) as { state_json: string }).state_json) as Record<string, unknown>;
  return { store, run, state, events, mutate, storedJson };
};

const CALL: RunEventPayload = { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Write', kind: 'edit', title: 'Write', rawInput: {} };

const classifiedWithoutDigest = { type: 'tool.permission.classified', callId: 'c1', outcome: 'allow' } as unknown as RunEventPayload;

describe('snapshot state version 11', () => {
  it('writes stateVersion 15', () => {
    const { storedJson } = storedSnapshot();
    expect(storedJson()['stateVersion']).toBe(15);
  });

  it('reports a snapshot without the working facts as corrupt', () => {
    const { store, run, mutate } = storedSnapshot();
    mutate("json_remove(state_json, '$.workingFacts')");
    expect(() => store.load(run.id)).toThrow(/corrupt/);
  });

  it('treats a version 9 snapshot as absent and rebuilds it from the journal', () => {
    const { store, run, state, events, mutate } = storedSnapshot();
    mutate("json_set(state_json, '$.stateVersion', 9)");
    const loaded = store.load(run.id);
    expect(loaded.snapshot).toBeUndefined();
    expect(loaded.tail).toEqual(events);
    expect(loaded.tail.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }) as RunState)).toEqual(state);
  });

  it('folds a classification journaled without a subject digest into no classification, so the snapshot stays readable', () => {
    const { store, run, state } = storedSnapshot([CALL, classifiedWithoutDigest]);
    expect(state.pendingCalls['c1']).toBeDefined();
    expect(state.pendingCalls['c1']).not.toHaveProperty('classification');
    expect(store.load(run.id).snapshot?.state).toEqual(state);
  });

  it('round-trips taskSeq and inherited for an inheriting run', () => {
    const { store, run, state, storedJson } = storedSnapshot([INHERITED]);
    expect(state.taskSeq).toBe(3);
    expect(state.inherited).toEqual({ fromRunId: 'run-prev', fromLastSeq: 7, digest: INHERITED.digest });
    expect(storedJson()['taskSeq']).toBe(3);
    expect(store.load(run.id).snapshot?.state).toEqual(state);
  });

  it('treats a version 6 snapshot of an inheriting run as absent and replays the event from the journal', () => {
    const { store, run, state, events, mutate } = storedSnapshot([INHERITED]);
    mutate("json_set(state_json, '$.stateVersion', 6)");
    const loaded = store.load(run.id);
    expect(loaded.snapshot).toBeUndefined();
    expect(loaded.tail).toEqual(events);
    expect(loaded.tail.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }) as RunState)).toEqual(state);
  });

  it('round-trips streaming with seen, the mode and a plain-message summary', () => {
    const { store, run, state } = storedSnapshot();
    expect(state.mode).toBe('plan');
    expect(state.streaming).toEqual({ step: 2, attempt: 1, seen: true, items: [{ itemId: 'm2', text: 'partial answer' }] });
    expect(state.summary).toEqual({ item: PLAIN, summary: 'first part', replacedThroughSeq: 3 });
    const loaded = store.load(run.id);
    expect(loaded.tail).toEqual([]);
    expect(loaded.snapshot?.state).toEqual(state);
  });

  it('treats an otherwise valid version 6 snapshot as absent and falls back to the full fold', () => {
    const { store, run, state, events, mutate } = storedSnapshot();
    mutate("json_set(state_json, '$.stateVersion', 6)");
    const loaded = store.load(run.id);
    expect(loaded.snapshot).toBeUndefined();
    expect(loaded.tail).toEqual(events);
    expect(loaded.tail.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }) as RunState)).toEqual(state);
  });

  it.each([
    ['a streaming record whose seen is not a boolean', "json_set(state_json, '$.streaming.seen', 'yes')"],
    ['a streaming item whose text is not a string', "json_set(state_json, '$.streaming.items[0].text', 7)"],
    ['a streaming record without a step', "json_remove(state_json, '$.streaming.step')"],
    ['an unknown mode', "json_set(state_json, '$.mode', 'yolo')"],
    ['a plain-message summary whose role is not user', "json_set(state_json, '$.summary.item.role', 'assistant')"],
    ['a plain-message summary without string content', "json_set(state_json, '$.summary.item.content', 3)"],
  ])('reports a snapshot with %s as corrupt', (_label, expression) => {
    const { store, run, mutate } = storedSnapshot();
    mutate(expression);
    expect(() => store.load(run.id)).toThrow(/corrupt/);
  });

  it.each([
    ['a taskSeq that is not an integer', "json_set(state_json, '$.taskSeq', 'one')"],
    ['no taskSeq', "json_remove(state_json, '$.taskSeq')"],
    ['an inherited record without a digest', "json_remove(state_json, '$.inherited.digest')"],
    ['an inherited record whose fromLastSeq is not an integer', "json_set(state_json, '$.inherited.fromLastSeq', 'seven')"],
    ['an inherited record whose fromRunId is not a string', "json_set(state_json, '$.inherited.fromRunId', 3)"],
  ])('reports an inheriting snapshot with %s as corrupt', (_label, expression) => {
    const { store, run, mutate } = storedSnapshot([INHERITED]);
    mutate(expression);
    expect(() => store.load(run.id)).toThrow(/corrupt/);
  });
});
