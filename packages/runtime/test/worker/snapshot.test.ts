import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { foldRunState } from '@momonga/store';
import { SNAPSHOT_STATE_VERSION } from '../../../store/src/codec.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const expectSnapshotAtYield = (env: Env, runId: string): void => {
  const loaded = env.store.load(runId);
  const snapshot = loaded.snapshot;
  if (snapshot === undefined) throw new Error('expected a snapshot at yield');
  expect(snapshot.seq).toBe(env.run(runId).lastSeq - 1);
  expect(loaded.tail.map((event) => event.type)).toEqual(['run.status']);
  expect(loaded.tail.reduce(foldRunState, snapshot.state)).toEqual(env.fold(runId));
};

describe('worker snapshots', () => {
  it('writes a snapshot right before a terminal transition', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Done.'));
    const run = env.enqueue();
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('COMPLETED');
    expectSnapshotAtYield(env, run.id);
  });

  it('writes a snapshot right before releasing to WAITING_HUMAN, carrying pins and the suggested rule', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'snap.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]));
    const run = env.enqueue();
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expectSnapshotAtYield(env, run.id);
    const state = env.store.load(run.id).snapshot?.state;
    expect(state?.pins).toEqual(env.ofType(run.id, 'run.started')[0]?.pins);
    expect(state?.pendingCalls[env.gateway.callId('call_w_1')]?.suggestedRule).toBe(`Write(/${target})`);
  });

  it('writes the snapshot with state version 11, carrying the recorded mode, the task seq, the loop groups and the working facts', async (context) => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    env.gateway.script.push(textStep('Done.'));
    const run = env.enqueue();
    await env.runOnce(env.worker());
    const db = new DatabaseSync(env.dbPath);
    context.onTestFinished(() => db.close());
    const row = db.prepare('SELECT state_json FROM snapshots WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(run.id) as { state_json: string } | undefined;
    expect(row).toBeDefined();
    const stored = JSON.parse(row!.state_json) as Record<string, unknown>;
    expect(stored['stateVersion']).toBe(SNAPSHOT_STATE_VERSION);
    expect(stored['loopGroups']).toEqual([]);
    expect(stored['workingFacts']).toMatchObject({ written: [], commands: [], messages: [] });
    expect(stored['mode']).toBe('acceptEdits');
    expect(stored['taskSeq']).toBe(1);
    expect(env.store.load(run.id).snapshot?.state.mode).toBe('acceptEdits');
  });
});
