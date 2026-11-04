import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { SNAPSHOT_STATE_VERSION, decodeEvent } from '../src/codec.ts';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';
import { callItem, foldOf, requested, responded, task, toolCall, toolDone } from './inherit-fixtures.ts';

const ENVELOPE = { id: 9, runId: 'r1', sessionId: 's1', seq: 5, step: 1, leaseToken: 1, createdAt: 10 };

const row = (payload: Record<string, unknown>): never =>
  ({
    id: ENVELOPE.id,
    run_id: ENVELOPE.runId,
    session_id: ENVELOPE.sessionId,
    seq: ENVELOPE.seq,
    step: ENVELOPE.step,
    lease_token: ENVELOPE.leaseToken,
    created_at: ENVELOPE.createdAt,
    type: payload['type'],
    payload_json: JSON.stringify(payload),
  }) as never;

const HANDLE = 'a'.repeat(64);

describe('the token events in the journal', () => {
  it.each([
    ['tool.loaded', { names: ['Grep', 'Glob'] }],
    ['loop.warned', { signature: 'sig-1' }],
  ])('decodes %s', (type, fields) => {
    const payload = { type, ...fields };
    expect(decodeEvent(row(payload))).toEqual({ ...payload, ...ENVELOPE });
  });

  it('decodes a tool.completed that names its formatter', () => {
    const payload = { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'x', handle: HANDLE, formatted: { formatter: 'log', version: 1 } };
    expect(decodeEvent(row(payload))).toEqual({ ...payload, ...ENVELOPE });
  });
});

describe('the token state of a run', () => {
  it('starts with no loaded tools and no loop warning', () => {
    const state = initialRunState({ runId: 'r1', sessionId: 's1' });
    expect(state.loadedTools).toEqual([]);
    expect(state.loopWarned).toBeUndefined();
  });

  it('appends loaded tools in load order and never removes or repeats one', () => {
    const state = foldOf([
      task('find it'),
      { type: 'tool.loaded', names: ['Grep', 'Glob'] } as RunEventPayload,
      { type: 'tool.loaded', names: ['WebFetch', 'Grep'] } as RunEventPayload,
    ]);
    expect(state.loadedTools).toEqual(['Grep', 'Glob', 'WebFetch']);
  });

  it('records the signature of the last loop warning', () => {
    const state = foldOf([task('loop'), { type: 'loop.warned', signature: 'sig-1' } as RunEventPayload, { type: 'loop.warned', signature: 'sig-2' } as RunEventPayload]);
    expect(state.loopWarned).toEqual({ signature: 'sig-2' });
  });

  it('records the event seq of a loaded instruction file and of an activated skill', () => {
    const state = foldOf([
      task('work'),
      { type: 'instructions.loaded', path: '/work/a/pkg/AGENTS.md', content: 'nested rules' },
      { type: 'skill.activated', name: 'pdf', content: 'skill body' },
      { type: 'instructions.loaded', path: '/work/a/lib/AGENTS.md', content: 'more rules' },
    ]);
    expect(state.loadedInstructions.map((entry) => [entry.path, entry.seq])).toEqual([
      ['/work/a/pkg/AGENTS.md', 2],
      ['/work/a/lib/AGENTS.md', 4],
    ]);
    expect(state.activatedSkills.map((skill) => [skill.name, skill.seq])).toEqual([['pdf', 3]]);
  });

  it('gives a reference its handle without evicting the referring output', () => {
    const state = foldOf([
      task('read twice'),
      requested(1),
      responded(1, [callItem('c1')]),
      toolCall('c1'),
      ...toolDone('c1', 'same bytes'),
      { type: 'context.truncated', callId: 'c1', handle: HANDLE, kind: 'reference' } as RunEventPayload,
    ]);
    expect(state.history.find((entry) => entry.callId === 'c1' && entry.item.type === 'function_call_output')?.handle).toBe(HANDLE);
    expect(state.evicted).toEqual([]);
  });
});

const JOURNAL: RunEventPayload[] = [
  { type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm' } },
  { type: 'instructions.loaded', path: '/work/a/pkg/AGENTS.md', content: 'nested rules' },
  { type: 'skill.activated', name: 'pdf', content: 'skill body' },
  { type: 'tool.loaded', names: ['Grep'] } as RunEventPayload,
  { type: 'loop.warned', signature: 'sig-1' } as RunEventPayload,
];

const storedSnapshot = () => {
  const { dbPath, store } = harness();
  const run = enqueue(store, newSession(store).id, 'continue the work');
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, JOURNAL).kind).toBe('ok');
  const events: RunEvent[] = store.readRunEvents(run.id, 0, 1000);
  const state = events.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }));
  expect(store.writeSnapshot(claim, events[events.length - 1]!.seq, state)).toEqual({ kind: 'ok' });
  const db = rawDb(dbPath);
  const mutate = (expression: string): void => {
    db.prepare(`UPDATE snapshots SET state_json = ${expression} WHERE run_id = ?`).run(run.id);
  };
  const storedJson = (): Record<string, unknown> =>
    JSON.parse((db.prepare('SELECT state_json FROM snapshots WHERE run_id = ?').get(run.id) as { state_json: string }).state_json) as Record<string, unknown>;
  return { store, run, state, events, mutate, storedJson };
};

describe('snapshot state version 13', () => {
  it('is version 13 and is written as such', () => {
    expect(SNAPSHOT_STATE_VERSION).toBe(13);
    expect(storedSnapshot().storedJson()['stateVersion']).toBe(13);
  });

  it('round-trips the loaded tools, the loop warning and the arrival seqs', () => {
    const { store, run, state } = storedSnapshot();
    expect(state.loadedTools).toEqual(['Grep']);
    expect(state.loopWarned).toEqual({ signature: 'sig-1' });
    expect(store.load(run.id).snapshot?.state).toEqual(state);
  });

  it('treats a version 12 snapshot as absent and rebuilds the state from the journal', () => {
    const { store, run, state, events, mutate } = storedSnapshot();
    mutate("json_set(state_json, '$.stateVersion', 12)");
    const loaded = store.load(run.id);
    expect(loaded.snapshot).toBeUndefined();
    expect(loaded.tail).toEqual(events);
    expect(loaded.tail.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }) as RunState)).toEqual(state);
  });

  it.each([
    ['no loaded tools', "json_remove(state_json, '$.loadedTools')"],
    ['a loaded tool that is not a string', "json_set(state_json, '$.loadedTools[0]', 3)"],
    ['a loop warning without a signature', "json_remove(state_json, '$.loopWarned.signature')"],
    ['a loaded instruction without a seq', "json_remove(state_json, '$.loadedInstructions[0].seq')"],
    ['an activated skill without a seq', "json_remove(state_json, '$.activatedSkills[0].seq')"],
  ])('reports a snapshot with %s as corrupt', (_label, expression) => {
    const { store, run, mutate } = storedSnapshot();
    mutate(expression);
    expect(() => store.load(run.id)).toThrow(/corrupt/);
  });
});
