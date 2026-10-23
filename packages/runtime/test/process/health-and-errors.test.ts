import { describe, expect, it } from 'vitest';
import { launchRuntime, readDb, startStack } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: 60_000 };

describe('health through startRuntimeProcess (system timers, in-process gateway)', () => {
  it('health startedAt equals the ready line', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const ready = JSON.parse(launched.stdout.lines()[0] ?? '{}');
    const health = await launched.http('GET', '/v1/health');
    expect(health.json).toMatchObject({ startedAt: ready.startedAt, version: ready.version, state: 'running' });
    expect(health.json.startedAt).toBe(launched.handle.ready.startedAt);
  });

  it('health state is draining during close', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp, { drainTimeoutMs: 60_000 });
    const hold = stack.hold();
    const session = await launched.createSession();
    await launched.createRun(session.id);
    await hold.waitForRequest();
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

  it('the lease and health pid equal the ready pid', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const hold = stack.hold();
    const ready = JSON.parse(launched.stdout.lines()[0] ?? '{}');
    expect(ready.pid).toBe(process.pid);
    expect((await launched.http('GET', '/v1/health')).json.pid).toBe(ready.pid);
    const session = await launched.createSession();
    const run = await launched.createRun(session.id);
    await hold.waitForRequest();
    const owner = readDb<{ lease_owner: string }>(stack.temp.paths.databases.runtime, 'SELECT lease_owner FROM runs WHERE id = ?', run.id)[0]?.lease_owner;
    expect(owner?.split('-')[1]).toBe(String(ready.pid));
    hold.release();
  });
});
