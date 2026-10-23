import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worker, WorkerOptions } from '@momonga/runtime';
import { RUNTIME_VERSION, captureStream, hookLogger, isLockFree, startRuntimeProcess, startStack } from './run-helpers.ts';
import { waitFor } from '@momonga/testkit';
import type { RuntimeProcess } from './run-helpers.ts';

const control = vi.hoisted(() => ({ onFatal: [] as ((error: Error) => void)[], aborts: 0 }));

vi.mock('../../src/worker/worker.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/worker/worker.ts')>();
  return {
    ...original,
    createWorker: (options: WorkerOptions): Worker => {
      control.onFatal.push(options.onFatal);
      const worker = original.createWorker(options);
      return {
        ...worker,
        abort: async (reason) => {
          control.aborts += 1;
          await worker.abort(reason);
        },
      };
    },
  };
});

const PROCESS_TIMEOUT = { timeout: 60_000 };

beforeEach(() => {
  control.onFatal = [];
  control.aborts = 0;
});

const outcomeOf = (started: Promise<RuntimeProcess>) =>
  started.then(
    (handle) => ({ handle }),
    (error: unknown) => ({ error }),
  );

describe('fatal at the ready line (system timers, in-process gateway)', () => {
  it.each(['during the ready line write', 'on the microtask after the ready line write'] as const)(
    'a fatal latched %s is never handed back as an un-aborted process',
    async (when) => {
      const stack = await startStack();
      const fatal = new Error(`fatal ${when}`);
      const stdout = captureStream();
      const write = stdout.write;
      stdout.write = (chunk) => {
        const written = write(chunk);
        const fire = () => control.onFatal[0]?.(fatal);
        if (when === 'during the ready line write') fire();
        else queueMicrotask(fire);
        return written;
      };
      const outcome = await outcomeOf(startRuntimeProcess({ home: stack.temp.home, version: RUNTIME_VERSION, logger: hookLogger(() => undefined), stdout }));
      if ('error' in outcome) {
        expect(outcome.error).toBe(fatal);
        expect(isLockFree(stack.temp.paths.locks.runtime)).toBe(true);
        return;
      }
      const { handle } = outcome;
      expect(await handle.fatal).toBe(fatal);
      await waitFor(() => control.aborts === 1, { description: 'the fatal-triggered abort' });
      const result = await handle.close();
      expect(result).toMatchObject({ clean: false, fatal });
      expect(isLockFree(stack.temp.paths.locks.runtime)).toBe(true);
    },
    60_000,
  );
});
