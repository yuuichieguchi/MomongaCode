import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

describe('the runs a worker reports in flight', () => {
  it('leave out a run once its terminal status is committed, while the claim is still winding down', async () => {
    const env = await makeEnv();
    let releaseTail: () => void = () => undefined;
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    let terminalCommitted: () => void = () => undefined;
    const committed = new Promise<void>((resolve) => {
      terminalCommitted = resolve;
    });
    const store: typeof env.store = {
      ...env.store,
      transition: async (...args: Parameters<typeof env.store.transition>) => {
        const result = await env.store.transition(...args);
        terminalCommitted();
        await tail;
        return result;
      },
    };
    const worker = env.worker('worker-1', { store });
    const run = await env.enqueue();
    env.gateway.script.push(textStep('Done.'));

    const running = env.runOnce(worker);
    await committed;
    expect(env.store.getRun(run.id)?.status).toBe('COMPLETED');
    expect(worker.runsInFlight()).toEqual([]);
    releaseTail();
    expect(await running).toBe('yielded');
  });
});
