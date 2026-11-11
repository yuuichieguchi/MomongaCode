import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { NEVER_CANCELLED } from '@momonga/testkit';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const snapshotRows = (env: Env, runId: string): number => {
  const db = new DatabaseSync(env.dbPath);
  try {
    return Number(db.prepare('SELECT count(*) AS count FROM snapshots WHERE run_id = ?').get(runId)?.['count']);
  } finally {
    db.close();
  }
};

describe('the run state a worker leaves', () => {
  it('writes no snapshot at a terminal transition, and the state loaded through the journal is the fold of the run', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Done.'));
    const run = await env.enqueue();
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(snapshotRows(env, run.id)).toBe(0);
    expect((await env.store.load(run.id, NEVER_CANCELLED)).state).toEqual(env.fold(run.id));
  });

  it('writes no snapshot at the yield to WAITING_HUMAN, and the loaded state carries the pins and the suggested rule', async () => {
    const env = await makeEnv();
    const target = path.join(env.project, 'snap.txt');
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: target, content: 'x' } }]));
    const run = await env.enqueue();
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(snapshotRows(env, run.id)).toBe(0);
    const { state, lastSeq } = await env.store.load(run.id, NEVER_CANCELLED);
    expect(lastSeq).toBe(env.run(run.id).lastSeq);
    expect(state).toEqual(env.fold(run.id));
    expect(state.pins).toEqual(env.ofType(run.id, 'run.started')[0]?.pins);
    expect(state.pendingCalls[env.gateway.callId('call_w_1')]?.suggestedRule).toBe(`Write(/${target})`);
  });

  it('the loaded state carries the recorded mode, the task seq, the loop groups and the working facts', async () => {
    const env = await makeEnv({ mode: 'acceptEdits' });
    env.gateway.script.push(callsStep([{ callId: 'call_b_1', name: 'Bash', args: { command: 'echo $(date)' } }]));
    const run = await env.enqueue();
    await env.runOnce(env.worker());
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    const { state } = await env.store.load(run.id, NEVER_CANCELLED);
    expect(state.loopGroups).toEqual([]);
    expect(state.workingFacts).toMatchObject({ written: [], commands: [], messages: [] });
    expect(state.mode).toBe('acceptEdits');
    expect(state.taskSeq).toBe(1);
  });
});
