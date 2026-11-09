import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { launchRuntime, readDb, startStack, waitForCondition } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type Held = { runId: string; reject(error: Error): void };

const control = vi.hoisted(() => ({
  order: [] as string[],
  preparers: [] as unknown[],
  threadOptions: [] as { databasePath: string; identity: { dev: number; ino: number }; silenceLimitMs: number }[],
  held: [] as Held[],
  rejections: [] as unknown[],
  storeClosed: false,
  writesAfterClose: [] as string[],
}));

const WRITES = new Set(['append', 'transition', 'release', 'releaseLease', 'appendAsService', 'requestCancel', 'writeSnapshot', 'finishCancelled', 'deadLetterExhausted', 'expireApprovals']);

vi.mock('../../src/memory/journal-thread-client.ts', async () => {
  const { JournalThreadError } = await import('@momonga/store');
  return {
    JournalThreadError,
    startJournalThread: async (options: { databasePath: string; identity: { dev: number; ino: number }; silenceLimitMs: number }) => {
      control.threadOptions.push(options);
      return {
        identity: options.identity,
        ping: async () => ({ threadId: 1 }),
        request: async () => ({}),
        inheritPlan: async () => ({ kind: 'none' }),
        inheritedWindow: async () => {
          throw new JournalThreadError('a first run of a fresh session has no inherited window');
        },
        measure: (request: { runId: string }) =>
          new Promise((_resolve, reject) => {
            control.held.push({
              runId: request.runId,
              reject: (error) => {
                control.rejections.push(error);
                reject(error);
              },
            });
          }),
        close: async () => {
          control.order.push('thread.close');
          for (const held of control.held.splice(0)) held.reject(new JournalThreadError('the journal thread was terminated'));
        },
      };
    },
  };
});

vi.mock('@momonga/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/store')>();
  return {
    ...original,
    openRuntimeStore: (options: Parameters<typeof original.openRuntimeStore>[0]) => {
      control.preparers.push((options as { preparer?: unknown }).preparer);
      const store = original.openRuntimeStore(options);
      return new Proxy(store, {
        get: (target, key, receiver) => {
          if (key === 'close') {
            return () => {
              control.order.push('store.close');
              control.storeClosed = true;
              target.close();
            };
          }
          const value = Reflect.get(target, key, receiver);
          if (typeof key === 'string' && WRITES.has(key) && typeof value === 'function') {
            return (...args: unknown[]) => {
              if (control.storeClosed) control.writesAfterClose.push(key);
              return (value as (...inner: unknown[]) => unknown).apply(target, args);
            };
          }
          return value;
        },
      });
    },
  };
});

beforeEach(() => {
  control.order = [];
  control.preparers = [];
  control.threadOptions = [];
  control.held = [];
  control.rejections = [];
  control.storeClosed = false;
  control.writesAfterClose = [];
});

describe('the journal thread in the runtime process (shutdown order, S3)', () => {
  it('is started over the runtime database, handed to the store as its preparer, and terminated only after the store is closed', async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);

    expect(control.threadOptions.map((options) => options.databasePath)).toEqual([stack.temp.paths.databases.runtime]);
    expect(control.preparers).toHaveLength(1);
    expect(control.preparers[0]).toMatchObject({ measure: expect.any(Function), close: expect.any(Function), ping: expect.any(Function), request: expect.any(Function) });

    await launched.handle.close();

    expect(control.order).toEqual(['store.close', 'thread.close']);
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('a terminal still awaiting the thread at shutdown rejects with JournalThreadError, commits nothing, and nothing is written after the store closes', async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp, { drainTimeoutMs: 200 });
    const session = await launched.createSession();
    const run = await launched.createRun(session.id);

    await waitForCondition(() => control.held.some((held) => held.runId === run.id), `the terminal of run ${run.id} to await the thread`);

    await launched.handle.close();

    expect(control.order).toEqual(['store.close', 'thread.close']);
    expect(control.rejections).toHaveLength(1);
    expect((control.rejections[0] as Error).name).toBe('JournalThreadError');
    expect(control.writesAfterClose).toEqual([]);
    const dbPath = stack.temp.paths.databases.runtime;
    expect(readDb<{ status: string }>(dbPath, 'SELECT status FROM runs WHERE id = ?', run.id)[0]?.status).toBe('RUNNING');
    expect(readDb<{ n: number }>(dbPath, "SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'context.contribution'", run.id)[0]?.n).toBe(0);
  }, REAL_PROCESS_TEST_TIMEOUT_MS);
});
