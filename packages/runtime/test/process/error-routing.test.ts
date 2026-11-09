import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpPool, McpPoolOptions } from '@momonga/mcp';
import { REAL_PROCESS_TEST_TIMEOUT_MS, DAEMON_PROCESS_TEST_TIMEOUT_MS, afterMicrotasks, createFakeClock, createFakeTimers, waitFor } from '@momonga/testkit';
import { START_MS, makeAbandonedDirectory } from './helpers.ts';
import { HOUR_MS, entriesNamed, launchRuntime, settledState, startStack } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type Injection = { error: Error; frame: string } | undefined;

const control = vi.hoisted(() => ({
  purge: undefined as Injection,
  sessionActivity: undefined as Injection,
  getRun: undefined as Injection,
  injected: 0,
}));

vi.mock('@momonga/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/store')>();
  const fire = (injection: Injection): void => {
    if (injection === undefined) return;
    if (!(new Error().stack ?? '').includes(injection.frame)) return;
    control.injected += 1;
    throw injection.error;
  };
  return {
    ...original,
    openRuntimeStore: (options: Parameters<typeof original.openRuntimeStore>[0]) => {
      const store = original.openRuntimeStore(options);
      const idempotency = new Proxy(store.idempotency, {
        get: (target, key, receiver) => {
          if (key === 'purgeExpired') {
            return (nowMs: number) => {
              fire(control.purge);
              return target.purgeExpired(nowMs);
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
      return new Proxy(store, {
        get: (target, key, receiver) => {
          if (key === 'idempotency') return idempotency;
          if (key === 'sessionActivity') {
            return (sessionId: string) => {
              fire(control.sessionActivity);
              return target.sessionActivity(sessionId);
            };
          }
          if (key === 'getRun') {
            return (runId: string) => {
              fire(control.getRun);
              return target.getRun(runId);
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
    },
  };
});

vi.mock('@momonga/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/mcp')>();
  return {
    ...original,
    createMcpPool: (_options: McpPoolOptions): McpPool => ({ sources: [], diagnostics: () => [], close: async () => undefined }),
  };
});

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const POOL_REFERENCE_AUDIT_MS = 300_000;

beforeEach(() => {
  control.purge = undefined;
  control.sessionActivity = undefined;
  control.getRun = undefined;
  control.injected = 0;
});

const fatalStoreError = (): Error => Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11, errstr: 'database disk image is malformed' });

const launchFake = async (fakeOptions: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) => {
  const stack = await startStack(fakeOptions, settings);
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const launched = await launchRuntime(stack.temp, { clock, fakeTimers: timers });
  return { stack, clock, timers, ...launched };
};

const expectLatched = async (launched: Awaited<ReturnType<typeof launchFake>>, error: Error): Promise<void> => {
  expect(await launched.handle.fatal).toBe(error);
  expect(entriesNamed(launched.logger, 'runtime.fatal')[0]?.fields?.err).toBe(error);
  expect(entriesNamed(launched.logger, 'runtime error')).toEqual([]);
};

const expectLoggedOnly = async (launched: Awaited<ReturnType<typeof launchFake>>, error: Error): Promise<void> => {
  expect(await settledState(launched.handle.fatal)).toBe('pending');
  expect(entriesNamed(launched.logger, 'runtime.fatal')).toEqual([]);
  expect(entriesNamed(launched.logger, 'runtime error').map((entry) => entry.fields?.err)).toContain(error);
};

const sweepSource = async (launched: Awaited<ReturnType<typeof launchFake>>, error: Error): Promise<void> => {
  makeAbandonedDirectory(path.join(launched.stack.temp.paths.tmp.sessions, 'unknown-session'));
  control.sessionActivity = { error, frame: 'tmp-sweep' };
  launched.timers.advance(HOUR_MS);
  await waitFor(() => control.injected > 0, { description: 'the hourly session sweep to reach sessionActivity' });
  await afterMicrotasks();
};

const poolCheckSource = async (launched: Awaited<ReturnType<typeof launchFake>>, error: Error): Promise<void> => {
  const hold = launched.stack.hold();
  const session = await launched.createSession();
  await launched.createRun(session.id);
  await hold.waitForRequest();
  control.getRun = { error, frame: 'mcp-pool-cache' };
  launched.timers.advance(POOL_REFERENCE_AUDIT_MS);
  await waitFor(() => control.injected > 0, { description: 'the pool reference audit to reach getRun' });
  await afterMicrotasks();
};

const MCP_SETTINGS = { mcpServers: { fx: { command: '/usr/bin/true', args: [] } } };

describe('error routing of composition-owned callbacks through report (fake timers and fake clock, in-process gateway)', () => {
  it('a fatal store error from the hourly purge latches fatal', PROCESS_TIMEOUT, async () => {
    const launched = await launchFake();
    const error = fatalStoreError();
    control.purge = { error, frame: '' };
    launched.timers.advance(HOUR_MS);
    await afterMicrotasks();
    await expectLatched(launched, error);
  });

  it('a non-fatal error from the hourly purge is only logged and the purge keeps running', PROCESS_TIMEOUT, async () => {
    const launched = await launchFake();
    const error = new Error('purge failed');
    control.purge = { error, frame: '' };
    launched.timers.advance(HOUR_MS);
    await afterMicrotasks();
    await expectLoggedOnly(launched, error);
    launched.timers.advance(HOUR_MS);
    await afterMicrotasks();
    expect(control.injected).toBe(2);
  });

  it('a fatal store error from the hourly session sweep latches fatal', PROCESS_TIMEOUT, async () => {
    const launched = await launchFake();
    const error = fatalStoreError();
    await sweepSource(launched, error);
    await expectLatched(launched, error);
  });

  it('a non-fatal error from the hourly session sweep is only logged', PROCESS_TIMEOUT, async () => {
    const launched = await launchFake();
    const error = new Error('session activity failed');
    await sweepSource(launched, error);
    await expectLoggedOnly(launched, error);
  });

  it('a fatal store error from a pool-cache check latches fatal', PROCESS_TIMEOUT, async () => {
    const launched = await launchFake({}, MCP_SETTINGS);
    const error = fatalStoreError();
    await poolCheckSource(launched, error);
    await expectLatched(launched, error);
  });

  it('a non-fatal error from a pool-cache check is only logged', PROCESS_TIMEOUT, async () => {
    const launched = await launchFake({}, MCP_SETTINGS);
    const error = new Error('pool check failed');
    await poolCheckSource(launched, error);
    await expectLoggedOnly(launched, error);
  });
});
