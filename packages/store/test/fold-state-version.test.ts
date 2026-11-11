import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { SNAPSHOT_STATE_VERSION } from '../src/codec.ts';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';
import { encodedRunState, foldedRunState } from './run-state-codec.ts';

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

const stored = async () => {
  const { dbPath, store } = harness();
  const run = await enqueue(store, newSession(store).id, 'remove a file');
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, journal).kind).toBe('ok');
  const events: RunEvent[] = store.readRunEvents(run.id, 0, 1000);
  const state = events.reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }) as RunState);
  const encoded = encodedRunState(state);
  return { store, run, state, events, mutate: encoded.mutate, storedJson: encoded.json, read: encoded.read };
};

describe('snapshot state version for removal and observation', () => {
  it('writes the current stateVersion', async () => {
    expect((await stored()).storedJson()['stateVersion']).toBe(SNAPSHOT_STATE_VERSION);
  });

  it('treats a version 14 snapshot as absent and refolds from the journal', async () => {
    const { store, run, state, mutate, read } = await stored();
    mutate("json_set(state_json, '$.stateVersion', 14)");
    expect(read()).toBeUndefined();
    expect(await foldedRunState(store, run.id)).toEqual(state);
  });

  it('round-trips a removed written fact and an observed command', async () => {
    const { state, read } = await stored();
    expect(state.workingFacts.written).toEqual([{ path: '/p/old.ts', removed: true, seq: expect.any(Number) }]);
    expect(read()).toEqual(state);
  });

  it('reports a snapshot whose removed flag is not true as corrupt', async () => {
    const { mutate, read } = await stored();
    mutate("json_set(state_json, '$.workingFacts.written[0].removed', 'yes')");
    expect(() => read()).toThrow(/corrupt/);
  });
});
