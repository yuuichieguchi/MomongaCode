import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureMomongaDirs } from '@momonga/foundation';
import type { RunServiceOptions } from '@momonga/runtime';
import { writeUserSettings } from './helpers.ts';
import {
  RUNTIME_VERSION,
  captureStream,
  entriesNamed,
  failureOf,
  hookLogger,
  isLockFree,
  launchRuntime,
  makeRunHome,
  settledState,
  startRuntimeProcess,
  startStack,
} from './run-helpers.ts';

const control = vi.hoisted(() => ({
  failDrain: undefined as Error | undefined,
  serviceOnError: [] as ((error: unknown) => void)[],
  flushError: undefined as Error | undefined,
  shutdowns: 0,
  storeCloses: 0,
  getRunError: undefined as Error | undefined,
}));

vi.mock('../../src/service/service.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/service/service.ts')>();
  return {
    ...original,
    createRunService: async (options: RunServiceOptions) => {
      control.serviceOnError.push(options.onError as (error: unknown) => void);
      const service = await original.createRunService(options);
      return {
        ...service,
        beginDraining: () => {
          if (control.failDrain !== undefined) throw control.failDrain;
          service.beginDraining();
        },
      };
    },
  };
});

vi.mock('@momonga/observability', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/observability')>();
  return {
    ...original,
    createTelemetry: (options: Parameters<typeof original.createTelemetry>[0]) => {
      const telemetry = original.createTelemetry(options);
      if (options.serviceName !== 'momonga-runtime') return telemetry;
      return {
        ...telemetry,
        forceFlush: async () => {
          if (control.flushError !== undefined) throw control.flushError;
          await telemetry.forceFlush();
        },
        shutdown: async () => {
          control.shutdowns += 1;
          await telemetry.shutdown();
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
      const store = original.openRuntimeStore(options);
      return new Proxy(store, {
        get: (target, key, receiver) => {
          if (key === 'close') {
            return () => {
              control.storeCloses += 1;
              target.close();
            };
          }
          if (key === 'getRun') {
            return (runId: string) => {
              if (control.getRunError !== undefined && runId === 'corrupt-run') throw control.getRunError;
              return target.getRun(runId);
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
    },
  };
});

const PROCESS_TIMEOUT = { timeout: 60_000 };

beforeEach(() => {
  control.failDrain = undefined;
  control.serviceOnError = [];
  control.flushError = undefined;
  control.shutdowns = 0;
  control.storeCloses = 0;
  control.getRunError = undefined;
});

const fatalStoreError = (): Error => Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11, errstr: 'database disk image is malformed' });

describe('shutdown and logging errors (system timers, in-process gateway)', () => {
  it.each(['close', 'abort'] as const)('a throwing beginDraining still runs teardown on %s, reports clean false and never rejects', async (method) => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    control.failDrain = new Error('beginDraining failed');
    const result = await launched.handle[method]();
    expect(result.clean).toBe(false);
    expect(isLockFree(stack.temp.paths.locks.runtime)).toBe(true);
    expect(control.storeCloses).toBe(1);
    expect(fs.existsSync(stack.temp.paths.sockets.runtime)).toBe(false);
  }, 60_000);

  it('a rejecting telemetry.forceFlush still calls telemetry.shutdown during teardown', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    control.flushError = new Error('flush failed');
    await launched.handle.close();
    expect(control.shutdowns).toBe(1);
    expect(isLockFree(stack.temp.paths.locks.runtime)).toBe(true);
  });

  it('a non-fatal service error is logged as service error and does not latch', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const error = new Error('service hiccup');
    control.serviceOnError[0]?.(error);
    expect(entriesNamed(launched.logger, 'service error').map((entry) => entry.fields?.err)).toEqual([error]);
    expect(entriesNamed(launched.logger, 'runtime error')).toEqual([]);
    expect(await settledState(launched.handle.fatal)).toBe('pending');
  });

  it('a fatal store error inside a request handler reaches fatal through the service', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const error = fatalStoreError();
    control.getRunError = error;
    const response = await launched.http('GET', '/v1/runs/corrupt-run');
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await launched.handle.fatal).toBe(error);
    expect(entriesNamed(launched.logger, 'service error').filter((entry) => entry.fields?.err === error)).toEqual([]);
    expect((await launched.handle.close()).fatal).toBe(error);
  });

  it('a failing cleanup during a failed-startup unwind is logged as startup.cleanup_failed and the original error is rethrown', PROCESS_TIMEOUT, async () => {
    const temp = makeRunHome();
    writeUserSettings(temp.home, { sandbox: 'none' });
    await ensureMomongaDirs(temp.paths);
    fs.writeFileSync(temp.paths.sockets.runtime, 'not a socket');
    const flushError = new Error('flush failed during unwind');
    control.flushError = flushError;
    const logger = hookLogger(() => undefined);
    const error = await failureOf(startRuntimeProcess({ home: temp.home, version: RUNTIME_VERSION, logger, stdout: captureStream() }));
    expect((error as Error).message).toBe(`${temp.paths.sockets.runtime} exists and is not a socket`);
    expect(entriesNamed(logger, 'startup.cleanup_failed').map((entry) => entry.fields?.err)).toEqual([flushError]);
    expect(control.shutdowns).toBe(1);
    expect(isLockFree(temp.paths.locks.runtime)).toBe(true);
  });
});
