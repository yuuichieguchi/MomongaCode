import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { SNAPSHOT_STATE_VERSION } from '../src/codec.ts';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const USAGE = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

const journal: RunEventPayload[] = [
  { type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm' } },
  {
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: { status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'Sh', arguments: '{}' }], usage: USAGE },
  },
  { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Sh', kind: 'execute', title: 'Sh', rawInput: {} },
  { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'ok', command: 'rm old.ts', exitCode: 0, files: [{ path: '/p/old.ts', access: 'remove' }] } as RunEventPayload,
];

const stored = () => {
  const { dbPath, store } = harness();
  const run = enqueue(store, newSession(store).id, 'remove a file');
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, journal).kind).toBe('ok');
  const events: RunEvent[] = store.readRunEvents(run.id, 0, 1000);
  const state = events.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }) as RunState);
  expect(store.writeSnapshot(claim, events[events.length - 1]!.seq, state)).toEqual({ kind: 'ok' });
  const db = rawDb(dbPath);
  const mutate = (expression: string): void => {
    db.prepare(`UPDATE snapshots SET state_json = ${expression} WHERE run_id = ?`).run(run.id);
  };
  const storedJson = (): Record<string, unknown> =>
    JSON.parse((db.prepare('SELECT state_json FROM snapshots WHERE run_id = ?').get(run.id) as { state_json: string }).state_json) as Record<string, unknown>;
  return { store, run, state, events, mutate, storedJson };
};

describe('snapshot state version for removal and observation', () => {
  it('writes the current stateVersion', () => {
    expect(stored().storedJson()['stateVersion']).toBe(SNAPSHOT_STATE_VERSION);
  });

  it('treats a version 14 snapshot as absent and refolds from the journal', () => {
    const { store, run, state, events, mutate } = stored();
    mutate("json_set(state_json, '$.stateVersion', 14)");
    const loaded = store.load(run.id);
    expect(loaded.snapshot).toBeUndefined();
    expect(loaded.tail).toEqual(events);
    expect(loaded.tail.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }) as RunState)).toEqual(state);
  });

  it('round-trips a removed written fact and an observed command', () => {
    const { store, run, state } = stored();
    expect(state.workingFacts.written).toEqual([{ path: '/p/old.ts', removed: true, seq: expect.any(Number) }]);
    expect(store.load(run.id).snapshot?.state).toEqual(state);
  });

  it('reports a snapshot whose removed flag is not true as corrupt', () => {
    const { store, run, mutate } = stored();
    mutate("json_set(state_json, '$.workingFacts.written[0].removed', 'yes')");
    expect(() => store.load(run.id)).toThrow(/corrupt/);
  });
});
