import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const SNAPSHOTS_AT_PLAIN_TERMINAL = 0;
const SNAPSHOTS_AT_FINISH_THEN_CANCEL = 0;
const SNAPSHOTS_AT_YIELD = 1;

const recording = (env: Env, beforeTransition: (to: string) => void | Promise<void>): { store: RuntimeStore; order: string[] } => {
  const order: string[] = [];
  const store: RuntimeStore = {
    ...env.store,
    writeSnapshot: (claim, seq, state) => {
      order.push('snapshot');
      return env.store.writeSnapshot(claim, seq, state);
    },
    transition: async (claim, from, to, patch, preceding) => {
      order.push(`transition:${to}`);
      await beforeTransition(to);
      return env.store.transition(claim, from, to, patch, preceding);
    },
  };
  return { store, order };
};

describe('the snapshots a worker terminal encodes on the loop (O14: a terminal transition writes no snapshot)', () => {
  it('writes none before the terminal transition of a completed run, and encodes no run state', async () => {
    const encoded: string[] = [];
    const env = await makeEnv({ onEncode: (kind) => void encoded.push(kind) });
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue('Work');
    const { store, order } = recording(env, () => undefined);

    await env.runOnce(env.worker('worker-1', { store }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(order.filter((entry) => entry === 'snapshot')).toHaveLength(SNAPSHOTS_AT_PLAIN_TERMINAL);
    expect(order).toEqual(['transition:COMPLETED']);
    expect(encoded).not.toContain('snapshot');
    expect(env.store.load(run.id).snapshot).toBeUndefined();
  });

  it('writes none when a cancel arrives between the final response and the transition', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue('Work');
    const { store, order } = recording(env, async (to) => {
      if (to === 'COMPLETED') await env.store.requestCancel(run.id);
    });

    await env.runOnce(env.worker('worker-1', { store }));

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(order.filter((entry) => entry === 'snapshot')).toHaveLength(SNAPSHOTS_AT_FINISH_THEN_CANCEL);
    expect(order).toEqual(['transition:COMPLETED', 'transition:CANCELLED']);
  });
});

describe('the snapshot a yield writes, which the next claim start reads (row 3: the incremental fold)', () => {
  it('writes exactly one at the yield to a human, at the last seq of the run, so the next claim folds no tail', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'approved' } }]));
    const run = env.enqueue('Work');
    const { store, order } = recording(env, () => undefined);

    expect(await env.runOnce(env.worker('worker-1', { store }))).toBe('yielded');

    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(order.filter((entry) => entry === 'snapshot')).toHaveLength(SNAPSHOTS_AT_YIELD);
    const loaded = env.store.load(run.id);
    expect(loaded.snapshot?.state.lastSeq).toBe(loaded.snapshot?.seq);
    expect(loaded.tail.every((event) => event.type === 'run.status' || event.type.startsWith('tool.permission'))).toBe(true);
  });
});
