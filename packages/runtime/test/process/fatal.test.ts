import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, DAEMON_PROCESS_TEST_TIMEOUT_MS, firstGeneration } from '@momonga/testkit';
import { corruptSchema, entriesNamed, isLockFree, launchRuntime, settledState, startStack } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };

describe('fatal errors under a running runtime (system timers, in-process gateway)', () => {
  it('a malformed schema under a running runtime resolves fatal after abort, close afterwards is a no-op and returns the same result with fatal set', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    corruptSchema(stack.temp.paths.databases.runtime);
    const fatal = await launched.handle.fatal;
    expect(fatal).toMatchObject({ errcode: 11 });
    expect(entriesNamed(launched.logger, 'runtime.fatal')[0]).toMatchObject({ level: 'error', fields: { err: fatal } });
    const aborted = await launched.handle.abort();
    expect(aborted).toEqual({ clean: false, fatal, abandoned: [], stragglers: [] });
    const closing = launched.handle.close();
    expect(await closing).toBe(aborted);
    expect(await isLockFree(firstGeneration(stack.temp.paths).locks.runtime)).toBe(true);
  });

  it('fatal stays pending after a normal close', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    expect(await launched.handle.close()).toEqual({ clean: true, abandoned: [], stragglers: [] });
    expect(await settledState(launched.handle.fatal)).toBe('pending');
  });
});
