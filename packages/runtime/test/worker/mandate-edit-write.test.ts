import { describe, expect, it, vi } from 'vitest';
import { SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

vi.setConfig({ testTimeout: SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS, hookTimeout: SOLVER_MULTI_QUERY_TEST_TIMEOUT_MS });

describe('a mandate whose allow list names both Edit(*) and Write(*)', () => {
  it('starts the run and reaches the model', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Done.'));
    const run = await env.enqueue('Change the files', { mandate: { scope: { allow: ['Edit(*)', 'Write(*)'] } } });

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});
