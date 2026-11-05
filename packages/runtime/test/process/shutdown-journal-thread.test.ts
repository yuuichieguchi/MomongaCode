import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { launchRuntime, startStack } from './run-helpers.ts';

const control = vi.hoisted(() => ({
  order: [] as string[],
  preparers: [] as unknown[],
  threadPaths: [] as string[],
  client: {
    measure: async (): Promise<never> => {
      throw new Error('no terminal is expected in this test');
    },
    close: async (): Promise<void> => undefined,
  },
}));

vi.mock('../../src/memory/journal-thread-client.ts', () => ({
  startJournalThread: async (options: { path: string }) => {
    control.threadPaths.push(options.path);
    return {
      measure: control.client.measure,
      close: async () => {
        control.order.push('thread.close');
      },
    };
  },
}));

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
              target.close();
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
    },
  };
});

beforeEach(() => {
  control.order = [];
  control.preparers = [];
  control.threadPaths = [];
});

describe('the journal thread in the runtime process', () => {
  it('is started over the runtime database, handed to the store as its preparer, and terminated only after the store is closed', async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);

    expect(control.threadPaths).toEqual([stack.temp.paths.databases.runtime]);
    expect(control.preparers).toHaveLength(1);
    expect(control.preparers[0]).toMatchObject({ measure: expect.any(Function) });

    await launched.handle.close();

    expect(control.order).toEqual(['store.close', 'thread.close']);
  }, DAEMON_PROCESS_TEST_TIMEOUT_MS);
});
