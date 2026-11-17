import { describe, expect, it } from 'vitest';
import { expectError, startService } from './helpers.ts';
import type { ServiceEnv } from './helpers.ts';

const endedRun = async (env: ServiceEnv, sessionId: string, status: 'FAILED' | 'COMPLETED') => {
  const run = await env.createRun(sessionId);
  const claim = env.claimRun(run.id);
  expect((await env.store.transition(claim, ['RUNNING'], status)).kind).toBe('ok');
  return run;
};

describe('the reflection of a run is queued by its end, never by a request', () => {
  it('answers 405 to a request for an ended run, and queues nothing', async () => {
    const env = await startService({ fakeTimers: true });
    const session = await env.createSession();
    const run = await endedRun(env, session.id, 'FAILED');

    const asked = await env.http('POST', `/v1/runs/${run.id}/reflection`);

    expectError(asked, 405, 'method_not_allowed');
    expect(env.store.reflection.get(run.id)).toBeUndefined();
    expect(env.store.reflection.next()).toBeUndefined();
  });
});
