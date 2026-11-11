import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { StoreIdentityError } from '@momonga/store';
import { REAL_PROCESS_TEST_TIMEOUT_MS, afterMicrotasks, createFakeClock, createFakeTimers, firstGeneration } from '@momonga/testkit';
import { START_MS, errnoError } from './helpers.ts';
import {
  RUNTIME_VERSION,
  STORE_IDENTITY_CHECK_MS,
  captureStream,
  entriesNamed,
  failureOf,
  hookLogger,
  isLockFree,
  launchRuntime,
  settledState,
  startRuntimeProcess,
  startStack,
  stepsLogged,
} from './run-helpers.ts';
import type { Launched, RunHome } from './run-helpers.ts';
import { FIRST_GENERATION } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const fakeTime = () => {
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  return { clock, timers };
};

const tick = async (timers: ReturnType<typeof createFakeTimers>, ms: number): Promise<void> => {
  timers.advance(ms);
  await afterMicrotasks();
};

const injectStatFailure = (file: string, error: Error) => {
  const realStatSync = fs.statSync;
  return vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
    if (String(target) === file) throw error;
    return realStatSync(target, options);
  }) as typeof fs.statSync);
};

const replaceFile = (file: string): void => {
  const copy = `${file}.replacement`;
  fs.copyFileSync(file, copy);
  fs.renameSync(copy, file);
};

const expectLatched = async (launched: Launched, timers: ReturnType<typeof createFakeTimers>) => {
  const fatal = await launched.handle.fatal;
  expect(fatal).toBeInstanceOf(StoreIdentityError);
  expect(launched.logger.entries).toContainEqual(expect.objectContaining({ level: 'error', msg: 'runtime.fatal', fields: expect.objectContaining({ err: fatal }) }));
  const result = await launched.handle.close();
  expect(result).toEqual({ clean: false, fatal, abandoned: [], stragglers: [] });
  return fatal;
};

const started = async (stack: { temp: RunHome }) => {
  const { clock, timers } = fakeTime();
  const launched = await launchRuntime(stack.temp, { clock, fakeTimers: timers });
  return { launched, timers };
};

describe('database identity check (fake timers and fake clock, in-process gateway)', () => {
  it('an unchanged database file never latches', async () => {
    const stack = await startStack();
    const { launched, timers } = await started(stack);
    for (let index = 0; index < 5; index += 1) await tick(timers, STORE_IDENTITY_CHECK_MS);
    expect(await settledState(launched.handle.fatal)).toBe('pending');
    expect(entriesNamed(launched.logger, 'runtime.fatal')).toEqual([]);
    expect(timers.pending().map((timer) => timer.delayMs)).toContain(STORE_IDENTITY_CHECK_MS);
  });

  it('renaming runtime.db latches fatal on the next identity tick', async () => {
    const stack = await startStack();
    const { launched, timers } = await started(stack);
    const db = stack.temp.paths.databases.runtime;
    fs.renameSync(db, `${db}.moved`);
    await tick(timers, STORE_IDENTITY_CHECK_MS - 1);
    expect(await settledState(launched.handle.fatal)).toBe('pending');
    await tick(timers, 1);
    expect(await settledState(launched.handle.fatal)).toBe('settled');
    await expectLatched(launched, timers);
  });

  it('unlinking runtime.db latches fatal on the next identity tick', async () => {
    const stack = await startStack();
    const { launched, timers } = await started(stack);
    fs.unlinkSync(stack.temp.paths.databases.runtime);
    await tick(timers, STORE_IDENTITY_CHECK_MS - 1);
    expect(await settledState(launched.handle.fatal)).toBe('pending');
    await tick(timers, 1);
    expect(await settledState(launched.handle.fatal)).toBe('settled');
    await expectLatched(launched, timers);
  });

  it('replacing runtime.db before ready fails startup with StoreIdentityError and unwinds', async () => {
    const stack = await startStack();
    const { clock, timers } = fakeTime();
    const logger = hookLogger((step, msg) => {
      if (msg === 'startup.step' && step === 'timers') replaceFile(stack.temp.paths.databases.runtime);
    });
    const stdout = captureStream();
    const error = await failureOf(startRuntimeProcess({ generation: FIRST_GENERATION, home: stack.temp.home, version: RUNTIME_VERSION, clock, timers, logger, stdout }));
    expect(error).toBeInstanceOf(StoreIdentityError);
    expect(stepsLogged(logger).at(-1)).toBe('ready');
    expect(stepsLogged(logger, 'teardown.step')).toEqual(['timers', 'workers', 'service', 'cancel-upstream', 'mcp-pools', 'background-jobs', 'tool-markers', 'gateway-client', 'telemetry', 'body-purge', 'trace-store', 'store', 'sandbox', 'lock']);
    expect(stdout.chunks).toEqual([]);
    expect(await isLockFree(firstGeneration(stack.temp.paths).locks.runtime)).toBe(true);
    expect(timers.pending()).toEqual([]);
  });

  it('a latched identity error aborts the process: close() afterwards returns the same result with fatal set', async () => {
    const stack = await startStack();
    const { launched, timers } = await started(stack);
    replaceFile(stack.temp.paths.databases.runtime);
    await tick(timers, STORE_IDENTITY_CHECK_MS);
    const fatal = await launched.handle.fatal;
    expect(fatal).toBeInstanceOf(StoreIdentityError);
    const aborted = await launched.handle.abort();
    const closed = await launched.handle.close();
    expect(closed).toBe(aborted);
    expect(closed).toEqual({ clean: false, fatal, abandoned: [], stragglers: [] });
    expect(await isLockFree(firstGeneration(stack.temp.paths).locks.runtime)).toBe(true);
    expect(timers.pending()).toEqual([]);
  });

  it('an EMFILE in the identity timer is reported, does not latch, and the timer keeps running', async () => {
    const stack = await startStack();
    const { launched, timers } = await started(stack);
    const injected = errnoError('EMFILE');
    const spy = injectStatFailure(stack.temp.paths.databases.runtime, injected);
    try {
      await tick(timers, STORE_IDENTITY_CHECK_MS);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await settledState(launched.handle.fatal)).toBe('pending');
    expect(entriesNamed(launched.logger, 'runtime.fatal')).toEqual([]);
    expect(launched.logger.entries).toContainEqual(expect.objectContaining({ level: 'error', msg: 'runtime error', fields: expect.objectContaining({ err: injected }) }));
    expect(timers.pending().map((timer) => timer.delayMs)).toContain(STORE_IDENTITY_CHECK_MS);
    fs.renameSync(stack.temp.paths.databases.runtime, `${stack.temp.paths.databases.runtime}.moved`);
    await tick(timers, STORE_IDENTITY_CHECK_MS);
    expect(await launched.handle.fatal).toBeInstanceOf(StoreIdentityError);
    await launched.handle.close();
  });

  it('an EMFILE in the identity check before ready fails startup with that error, not StoreIdentityError', async () => {
    const stack = await startStack();
    const { clock, timers } = fakeTime();
    const injected = errnoError('EMFILE');
    let spy: ReturnType<typeof injectStatFailure> | undefined;
    const logger = hookLogger((step, msg) => {
      if (msg === 'startup.step' && step === 'ready') spy = injectStatFailure(stack.temp.paths.databases.runtime, injected);
    });
    try {
      const error = await failureOf(startRuntimeProcess({ generation: FIRST_GENERATION, home: stack.temp.home, version: RUNTIME_VERSION, clock, timers, logger, stdout: captureStream() }));
      expect(error).toBe(injected);
      expect(error).not.toBeInstanceOf(StoreIdentityError);
    } finally {
      spy?.mockRestore();
    }
    expect(await isLockFree(firstGeneration(stack.temp.paths).locks.runtime)).toBe(true);
  });
});
