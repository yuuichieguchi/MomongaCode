import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, REAL_PROCESS_WAIT_MS } from '@momonga/testkit';
import { launchRuntime, readDb, startStack } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('health through startRuntimeProcess (system timers, in-process gateway)', () => {
  it('health startedAt equals the ready line', async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const ready = JSON.parse(launched.stdout.lines()[0] ?? '{}');
    const health = await launched.http('GET', '/v1/health');
    expect(health.json).toMatchObject({ startedAt: ready.startedAt, version: ready.version, state: 'running' });
    expect(health.json.startedAt).toBe(launched.handle.ready.startedAt);
  });

  it('health state is draining during close', async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp, { drainTimeoutMs: 60_000 });
    const hold = stack.hold();
    const session = await launched.createSession();
    await launched.createRun(session.id);
    await hold.waitForRequest({ timeoutMs: REAL_PROCESS_WAIT_MS, description: 'the held model request' });
    const closing = launched.handle.close();
    let health = await launched.http('GET', '/v1/health');
    for (let attempt = 0; attempt < 50 && health.json?.state !== 'draining'; attempt += 1) health = await launched.http('GET', '/v1/health');
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ state: 'draining' });
    const aborted = launched.handle.abort();
    expect(aborted).toBe(closing);
    hold.release();
    expect(await closing).toMatchObject({ abandoned: [], stragglers: [] });
  });

  it('the lease and health pid equal the ready pid', async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const hold = stack.hold();
    const ready = JSON.parse(launched.stdout.lines()[0] ?? '{}');
    expect(ready.pid).toBe(process.pid);
    expect((await launched.http('GET', '/v1/health')).json.pid).toBe(ready.pid);
    const session = await launched.createSession();
    const run = await launched.createRun(session.id);
    await hold.waitForRequest({ timeoutMs: REAL_PROCESS_WAIT_MS, description: 'the held model request' });
    const owner = readDb<{ lease_owner: string }>(stack.temp.paths.databases.runtime, 'SELECT lease_owner FROM runs WHERE id = ?', run.id)[0]?.lease_owner;
    expect(owner?.split('-')[1]).toBe(String(ready.pid));
    hold.release();
  });
});
