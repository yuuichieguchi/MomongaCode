import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';

const SNAPSHOTS_AT_PLAIN_TERMINAL = 1;
const SNAPSHOTS_AT_FINISH_THEN_CANCEL = 2;

const recording = (env: Env, beforeTransition: (to: string) => void): { store: RuntimeStore; order: string[] } => {
  const order: string[] = [];
  const store: RuntimeStore = {
    ...env.store,
    writeSnapshot: (claim, seq, state) => {
      order.push('snapshot');
      return env.store.writeSnapshot(claim, seq, state);
    },
    transition: (claim, from, to, patch, preceding) => {
      order.push(`transition:${to}`);
      beforeTransition(to);
      return env.store.transition(claim, from, to, patch, preceding);
    },
  };
  return { store, order };
};

describe('the snapshots a worker terminal encodes on the loop', () => {
  it('writes exactly one before the terminal transition of a completed run', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue('Work');
    const { store, order } = recording(env, () => undefined);

    await env.runOnce(env.worker('worker-1', { store }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(order.filter((entry) => entry === 'snapshot')).toHaveLength(SNAPSHOTS_AT_PLAIN_TERMINAL);
    expect(order.slice(-2)).toEqual(['snapshot', 'transition:COMPLETED']);
    expect(env.store.load(run.id).snapshot).toBeDefined();
  });

  it('writes exactly two when a cancel arrives between the final response and the transition', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue('Work');
    const { store, order } = recording(env, (to) => {
      if (to === 'COMPLETED') env.store.requestCancel(run.id);
    });

    await env.runOnce(env.worker('worker-1', { store }));

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(order.filter((entry) => entry === 'snapshot')).toHaveLength(SNAPSHOTS_AT_FINISH_THEN_CANCEL);
    expect(order).toEqual(['snapshot', 'transition:COMPLETED', 'snapshot', 'transition:CANCELLED']);
  });
});
