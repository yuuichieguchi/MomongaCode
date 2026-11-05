import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

describe('the snapshot a worker terminal writes on the loop', () => {
  it('encodes the whole run state once before the terminal transition of a completed run', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('done'));
    const run = env.enqueue('Work');
    const order: string[] = [];
    const store: RuntimeStore = {
      ...env.store,
      writeSnapshot: (claim, seq, state) => {
        order.push(`snapshot@${seq}`);
        return env.store.writeSnapshot(claim, seq, state);
      },
      transition: (claim, from, to, patch, preceding) => {
        order.push(`transition:${to}`);
        return env.store.transition(claim, from, to, patch, preceding);
      },
    };

    await env.runOnce(env.worker('worker-1', { store }));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(order.at(-2)).toMatch(/^snapshot@/);
    expect(order.at(-1)).toBe('transition:COMPLETED');
    expect(env.store.load(run.id).snapshot).toBeDefined();
  });
});
