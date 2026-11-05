import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { LEASE_MS, makeEnv, typesOf } from './harness.ts';
import { textStep } from './scripts.ts';

describe('a run whose terminal transition failed after its final response was journaled', () => {
  it('is claimed again and finishes without a second model call', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('the final answer'));
    env.gateway.script.push(textStep('a second, paid answer'));
    const run = env.enqueue('Work');
    let failures = 0;
    const store: RuntimeStore = {
      ...env.store,
      transition: (claim, from, to, patch, preceding) => {
        if (to === 'COMPLETED' && failures === 0) {
          failures += 1;
          throw new Error('the journal thread failed');
        }
        return env.store.transition(claim, from, to, patch, preceding);
      },
    };

    expect(await env.runOnce(env.worker('worker-1', { store }))).toBe('yielded');
    expect(failures).toBe(1);
    expect(env.run(run.id).status).toBe('QUEUED');
    const afterFailure = env.run(run.id);

    env.clock.advance(LEASE_MS + 1);
    expect(await env.runOnce(env.worker('worker-2', { store }))).toBe('yielded');

    const types = typesOf(env.events(run.id));
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toHaveLength(1);
    expect(types.filter((type) => type === 'model.requested')).toHaveLength(1);
    expect(types.filter((type) => type === 'model.responded')).toHaveLength(1);
    expect(afterFailure.attempts).toBe(1);
    expect(env.run(run.id).attempts).toBe(2);
    expect(env.run(run.id).failedAttempts).toBe(0);
  });
});
