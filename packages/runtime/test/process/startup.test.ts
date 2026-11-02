import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@momonga/config';
import { ProcessLockHeldError, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import type { Worker, WorkerOptions } from '@momonga/runtime';
import { afterMicrotasks, createFakeClock, startLockHolder } from '@momonga/testkit';
import { START_MS, errnoError, trackGroup, writeInvalidUserSettings, writeUserSettings } from './helpers.ts';
import {
  RUNTIME_VERSION,
  STARTUP_STEPS,
  captureStream,
  clientOf,
  entriesNamed,
  failureOf,
  hookLogger,
  isLockFree,
  launchRuntime,
  makeRunHome,
  prepareStack,
  runtimeAlreadyRunningError,
  startRuntimeProcess,
  startStack,
  stepsLogged,
} from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

const control = vi.hoisted(() => ({
  events: [] as string[],
  failTelemetry: undefined as Error | undefined,
  failWorkerAt: -1,
  fatalOnStart: undefined as Error | undefined,
  workerCount: 0,
}));

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
              control.events.push('store.close');
              target.close();
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
    },
  };
});

vi.mock('@momonga/observability', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/observability')>();
  return {
    ...original,
    openTraceStore: (options: Parameters<typeof original.openTraceStore>[0]) => {
      const traceStore = original.openTraceStore(options);
      return new Proxy(traceStore, {
        get: (target, key, receiver) => {
          if (key === 'close') {
            return () => {
              control.events.push('trace-store.close');
              target.close();
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
    },
    createTelemetry: (options: Parameters<typeof original.createTelemetry>[0]) => {
      if (control.failTelemetry !== undefined) throw control.failTelemetry;
      return original.createTelemetry(options);
    },
  };
});

vi.mock('../../src/worker/worker.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/worker/worker.ts')>();
  return {
    ...original,
    createWorker: (options: WorkerOptions): Worker => {
      const index = control.workerCount;
      control.workerCount += 1;
      if (index === control.failWorkerAt) throw new Error(`worker ${index} failed to start`);
      const worker = original.createWorker(options);
      return {
        ...worker,
        start: () => {
          worker.start();
          if (control.fatalOnStart !== undefined) options.onFatal(control.fatalOnStart);
        },
        abort: async (reason) => {
          control.events.push(`abort ${options.workerId}`);
          await worker.abort(reason);
        },
      };
    },
  };
});

const PROCESS_TIMEOUT = { timeout: 60_000 };

beforeEach(() => {
  control.events = [];
  control.failTelemetry = undefined;
  control.failWorkerAt = -1;
  control.fatalOnStart = undefined;
  control.workerCount = 0;
});

const spawnDetachedSleeper = (): number => {
  const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('sleeper did not spawn');
  child.unref();
  trackGroup(pid);
  return pid;
};

const startBare = (temp: RunHome, extra: Record<string, unknown> = {}) => {
  const logger = hookLogger(() => undefined);
  const stdout = captureStream();
  return { logger, stdout, started: startRuntimeProcess({ home: temp.home, version: RUNTIME_VERSION, logger, stdout, ...extra }) };
};

const sandboxNoneHome = (): RunHome => {
  const temp = makeRunHome();
  writeUserSettings(temp.home, { sandbox: 'none' });
  return temp;
};

describe('startRuntimeProcess startup (system timers)', () => {
  it('logs startup.step lines in the pinned order', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    expect(stepsLogged(launched.logger)).toEqual([...STARTUP_STEPS]);
    expect(entriesNamed(launched.logger, 'startup.step').every((entry) => entry.level === 'debug')).toBe(true);
    expect(entriesNamed(launched.logger, 'runtime ready')).toHaveLength(1);
  });

  it('writes exactly one ready line to stdout, equal to RuntimeProcess.ready', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp, { clock: createFakeClock(START_MS) });
    const lines = launched.stdout.lines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ event: 'ready', ...launched.handle.ready });
    expect(launched.handle.ready).toEqual({
      service: 'runtime',
      pid: process.pid,
      version: RUNTIME_VERSION,
      socketPath: stack.temp.paths.sockets.runtime,
      startedAt: new Date(START_MS).toISOString(),
    });
    expect(launched.handle.sandbox).toBe('none');
  });

  it('takes the lock before the database: a held lock on a fresh home throws ProcessLockHeldError and state/runtime.db does not exist', PROCESS_TIMEOUT, async (context) => {
    const temp = sandboxNoneHome();
    await ensureMomongaDirs(temp.paths);
    const holder = (await startLockHolder(context, temp.paths.locks.runtime)).pid;
    const { started, stdout } = startBare(temp);
    const error = await failureOf(started);
    expect(error).toBeInstanceOf(ProcessLockHeldError);
    expect(error).toBeInstanceOf(runtimeAlreadyRunningError());
    expect(error).toMatchObject({ lockPath: temp.paths.locks.runtime, holderPid: holder });
    expect(fs.existsSync(temp.paths.databases.runtime)).toBe(false);
    expect(fs.readFileSync(temp.paths.locks.runtime, 'utf8').trim()).toBe(String(holder));
    expect(stdout.chunks).toEqual([]);
  });

  it('a second instance on the same home throws ProcessLockHeldError whose lockPath is the runtime lock', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    await launchRuntime(stack.temp);
    const { started, stdout } = startBare(stack.temp);
    const error = await failureOf(started);
    expect(error).toBeInstanceOf(runtimeAlreadyRunningError());
    expect(error).toMatchObject({ lockPath: stack.temp.paths.locks.runtime, holderPid: process.pid });
    expect(stdout.chunks).toEqual([]);
    expect((await clientOf(stack.temp).http('GET', '/v1/health')).status).toBe(200);
  });

  it('a ProcessLockHeldError from the runtime socket lock (a live pid in runtime.sock.lock) has a lockPath other than the runtime lock', PROCESS_TIMEOUT, async (context) => {
    const temp = sandboxNoneHome();
    await ensureMomongaDirs(temp.paths);
    const holder = (await startLockHolder(context, `${temp.paths.sockets.runtime}.lock`)).pid;
    const { started, stdout } = startBare(temp);
    const error = await failureOf(started);
    expect(error).toBeInstanceOf(ProcessLockHeldError);
    expect(error).not.toBeInstanceOf(runtimeAlreadyRunningError());
    expect(error).toMatchObject({ lockPath: `${temp.paths.sockets.runtime}.lock`, holderPid: holder });
    expect(await isLockFree(temp.paths.locks.runtime)).toBe(true);
    expect(stdout.chunks).toEqual([]);
  });

  it('invalid user settings throw ConfigError, release the lock and print no ready line', PROCESS_TIMEOUT, async () => {
    const temp = makeRunHome();
    fs.mkdirSync(temp.paths.root, { recursive: true, mode: 0o700 });
    writeInvalidUserSettings(temp.home);
    const { started, stdout, logger } = startBare(temp);
    const error = await failureOf(started);
    expect(error).toBeInstanceOf(ConfigError);
    expect(stepsLogged(logger).at(-1)).toBe('settings');
    expect(await isLockFree(temp.paths.locks.runtime)).toBe(true);
    expect(fs.existsSync(temp.paths.databases.runtime)).toBe(false);
    expect(stdout.chunks).toEqual([]);
  });

  it('an EMFILE during the startup settings read is thrown unchanged, not as ConfigError (exit class 1)', PROCESS_TIMEOUT, async () => {
    const temp = sandboxNoneHome();
    const injected = errnoError('EMFILE');
    const realStatSync = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (String(file) === temp.paths.settingsFile) throw injected;
      return realStatSync(file, options);
    }) as typeof fs.statSync);
    try {
      const { started, logger } = startBare(temp);
      const error = await failureOf(started);
      expect(error).not.toBeInstanceOf(ConfigError);
      expect(error).toMatchObject({ code: 'EMFILE' });
      expect(stepsLogged(logger).at(-1)).toBe('settings');
    } finally {
      spy.mockRestore();
    }
    expect(await isLockFree(temp.paths.locks.runtime)).toBe(true);
  });

  it('a missing sandbox-exec (sandboxExecPath) throws ConfigError with the remediation text', PROCESS_TIMEOUT, async () => {
    const temp = makeRunHome();
    writeUserSettings(temp.home, { sandbox: 'seatbelt' });
    const missing = path.join(temp.root, 'no-sandbox-exec');
    const { started, stdout, logger } = startBare(temp, { sandboxExecPath: missing, platform: 'darwin' });
    const error = await failureOf(started);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(
      `sandbox-exec is not available at ${missing}; set "sandbox": "none" in ${temp.paths.settingsFile} to run without a sandbox (Bash will then ask before every command)`,
    );
    expect(stepsLogged(logger).at(-1)).toBe('sandbox');
    expect(await isLockFree(temp.paths.locks.runtime)).toBe(true);
    expect(stdout.chunks).toEqual([]);
  });

  it('a missing bwrap throws ConfigError naming bwrap on linux', PROCESS_TIMEOUT, async () => {
    const temp = makeRunHome();
    writeUserSettings(temp.home, { sandbox: 'bubblewrap' });
    const missing = path.join(temp.root, 'no-bwrap');
    const { started } = startBare(temp, { sandboxExecPath: missing, platform: 'linux' });
    const error = await failureOf(started);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(
      `bwrap is not available at ${missing}; set "sandbox": "none" in ${temp.paths.settingsFile} to run without a sandbox (Bash will then ask before every command)`,
    );
    expect(await isLockFree(temp.paths.locks.runtime)).toBe(true);
  });

  it('a sandbox kind from another operating system is a ConfigError', PROCESS_TIMEOUT, async () => {
    const temp = makeRunHome();
    writeUserSettings(temp.home, { sandbox: 'seatbelt' });
    const { started } = startBare(temp, { platform: 'linux' });
    const error = await failureOf(started);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('sandbox "seatbelt" is only available on darwin');
  });

  it('sandbox none skips the sandbox-exec check and logs the warning', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack();
    const launched = await launchRuntime(stack.temp, { sandboxExecPath: path.join(stack.temp.root, 'no-sandbox-exec') });
    expect(launched.handle.sandbox).toBe('none');
    expect(launched.logger.entries).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'sandbox is none: Bash asks before every command' }));
    expect((await launched.http('GET', '/v1/health')).json).toMatchObject({ sandbox: 'none' });
  });

  it('a late failure (runtime.sock path occupied by a regular file) unwinds: the lock is free, the store is closed and the error is rethrown unchanged', PROCESS_TIMEOUT, async () => {
    const temp = sandboxNoneHome();
    await ensureMomongaDirs(temp.paths);
    fs.writeFileSync(temp.paths.sockets.runtime, 'not a socket');
    const { started, stdout, logger } = startBare(temp);
    const error = await failureOf(started);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect((error as Error).message).toBe(`${temp.paths.sockets.runtime} exists and is not a socket`);
    expect(stepsLogged(logger).at(-1)).toBe('service');
    expect(stepsLogged(logger, 'teardown.step')).toEqual(['cancel-upstream', 'mcp-pools', 'background-jobs', 'gateway-client', 'telemetry', 'trace-store', 'store', 'lock']);
    expect(control.events).toEqual(['trace-store.close', 'store.close']);
    expect(await isLockFree(temp.paths.locks.runtime)).toBe(true);
    expect(stdout.chunks).toEqual([]);
  });

  it('a telemetry failure after the trace store opened closes the trace store', PROCESS_TIMEOUT, async () => {
    const temp = sandboxNoneHome();
    const injected = new Error('telemetry failed');
    control.failTelemetry = injected;
    const { started, stdout, logger } = startBare(temp);
    expect(await failureOf(started)).toBe(injected);
    expect(stepsLogged(logger).at(-1)).toBe('telemetry');
    expect(stepsLogged(logger, 'teardown.step')).toEqual(['trace-store', 'store', 'lock']);
    expect(control.events).toEqual(['trace-store.close', 'store.close']);
    expect(await isLockFree(temp.paths.locks.runtime)).toBe(true);
    expect(stdout.chunks).toEqual([]);
  });

  it('a failure on worker 1 aborts worker 0 first and closes the store after it', PROCESS_TIMEOUT, async () => {
    const temp = sandboxNoneHome();
    control.failWorkerAt = 1;
    const { started, stdout } = startBare(temp, { workerCount: 3, clock: createFakeClock(START_MS) });
    const error = await failureOf(started);
    expect((error as Error).message).toBe('worker 1 failed to start');
    expect(control.events).toEqual([`abort runtime-${process.pid}-${START_MS}-0`, 'trace-store.close', 'store.close']);
    expect(control.workerCount).toBe(2);
    expect(await isLockFree(temp.paths.locks.runtime)).toBe(true);
    expect(stdout.chunks).toEqual([]);
  });

  it('a fatal latched during startup, in any step before ready, fails startup with that error and unwinds', PROCESS_TIMEOUT, async () => {
    const temp = sandboxNoneHome();
    const fatal = new Error('fatal while starting');
    control.fatalOnStart = fatal;
    const { started, stdout, logger } = startBare(temp);
    expect(await failureOf(started)).toBe(fatal);
    expect(logger.entries).toContainEqual(expect.objectContaining({ level: 'error', msg: 'runtime.fatal', fields: expect.objectContaining({ err: fatal }) }));
    expect(stepsLogged(logger)).toEqual([...STARTUP_STEPS]);
    expect(stepsLogged(logger, 'teardown.step')).toEqual(['timers', 'workers', 'service', 'cancel-upstream', 'mcp-pools', 'background-jobs', 'gateway-client', 'telemetry', 'trace-store', 'store', 'lock']);
    expect(control.events.at(-1)).toBe('store.close');
    expect(await isLockFree(temp.paths.locks.runtime)).toBe(true);
    expect(stdout.chunks).toEqual([]);
  });

  it('starts without the gateway running', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack();
    const launched = await launchRuntime(stack.temp);
    expect(launched.stdout.lines()).toHaveLength(1);
    expect(fs.existsSync(stack.temp.paths.sockets.gateway)).toBe(false);
    expect((await launched.http('GET', '/v1/health')).status).toBe(200);
  });

  it('an invalid home, gatewaySocketPath, workerCount, leaseMs or drainTimeoutMs throws before any step', PROCESS_TIMEOUT, async () => {
    const temp = sandboxNoneHome();
    const cases: [Record<string, unknown>, ErrorConstructor | TypeErrorConstructor | RangeErrorConstructor][] = [
      [{ home: 'relative/home' }, TypeError],
      [{ gatewaySocketPath: 'relative/gateway.sock' }, TypeError],
      [{ workerCount: 0 }, RangeError],
      [{ workerCount: 1.5 }, RangeError],
      [{ leaseMs: 0 }, RangeError],
      [{ leaseMs: 2.5 }, RangeError],
      [{ drainTimeoutMs: -1 }, RangeError],
      [{ drainTimeoutMs: 0.5 }, RangeError],
    ];
    for (const [options, kind] of cases) {
      const { started, logger, stdout } = startBare(temp, options);
      const error = await failureOf(started);
      expect(error, JSON.stringify(options)).toBeInstanceOf(kind);
      expect(stepsLogged(logger), JSON.stringify(options)).toEqual([]);
      expect(stdout.chunks).toEqual([]);
    }
    expect(fs.existsSync(temp.paths.run)).toBe(false);
  });

  it('accepts drainTimeoutMs 0', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack();
    const launched = await launchRuntime(stack.temp, { drainTimeoutMs: 0 });
    expect(launched.stdout.lines()).toHaveLength(1);
  });

  it('uses the canonical home everywhere for a symlinked or case-variant home', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack();
    const link = path.join(stack.temp.root, 'link');
    fs.symlinkSync(stack.temp.home, link);
    const viaLink = await startRuntimeProcess({ home: link, version: RUNTIME_VERSION, logger: hookLogger(() => undefined), stdout: captureStream() });
    try {
      expect(viaLink.ready.socketPath).toBe(stack.temp.paths.sockets.runtime);
      expect(fs.existsSync(stack.temp.paths.databases.runtime)).toBe(true);
      expect(fs.existsSync(stack.temp.paths.locks.runtime)).toBe(true);
      expect(fs.existsSync(path.join(link, '.momonga'))).toBe(true);
      expect(fs.lstatSync(path.join(stack.temp.home, '.momonga')).isDirectory()).toBe(true);
    } finally {
      await viaLink.close();
    }
    const upper = path.join(stack.temp.root, 'H');
    if (fs.existsSync(upper)) {
      const viaCase = await startRuntimeProcess({ home: upper, version: RUNTIME_VERSION, logger: hookLogger(() => undefined), stdout: captureStream() });
      try {
        expect(viaCase.ready.socketPath).toBe(momongaPaths(stack.temp.home, process.platform, {}).sockets.runtime);
      } finally {
        await viaCase.close();
      }
    }
  });
});

describe('startup cancellation through signal (system timers)', () => {
  it('a signal aborted on entry throws its reason before step 1', PROCESS_TIMEOUT, async () => {
    const temp = sandboxNoneHome();
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);
    const { started, logger, stdout } = startBare(temp, { signal: controller.signal });
    expect(await failureOf(started)).toBe(reason);
    expect(stepsLogged(logger)).toEqual([]);
    expect(stepsLogged(logger, 'teardown.step')).toEqual([]);
    expect(fs.existsSync(temp.paths.root)).toBe(true);
    expect(fs.existsSync(temp.paths.run)).toBe(false);
    expect(stdout.chunks).toEqual([]);
  });

  it.each([
    ['lock', ['lock']],
    ['store', ['store', 'lock']],
    ['telemetry', ['telemetry', 'trace-store', 'store', 'lock']],
    ['workers', ['workers', 'service', 'cancel-upstream', 'mcp-pools', 'background-jobs', 'gateway-client', 'telemetry', 'trace-store', 'store', 'lock']],
  ] as const)(
    'a signal aborted by the logger hook during step %s unwinds the registered cleanups and throws the reason unchanged, with no ready line and the lock free',
    async (step, teardown) => {
      const temp = sandboxNoneHome();
      const controller = new AbortController();
      const reason = new Error(`cancelled during ${step}`);
      const logger = hookLogger((logged, msg) => {
        if (msg === 'startup.step' && logged === step) controller.abort(reason);
      });
      const stdout = captureStream();
      const error = await failureOf(startRuntimeProcess({ home: temp.home, version: RUNTIME_VERSION, logger, stdout, signal: controller.signal }));
      expect(error).toBe(reason);
      expect(stepsLogged(logger).at(-1)).toBe(step);
      expect(stepsLogged(logger, 'teardown.step')).toEqual([...teardown]);
      expect(stdout.chunks).toEqual([]);
      expect(await isLockFree(temp.paths.locks.runtime)).toBe(true);
    },
    60_000,
  );

  it('a signal aborted during step 16 is honoured before the ready line', PROCESS_TIMEOUT, async () => {
    const temp = sandboxNoneHome();
    const controller = new AbortController();
    const reason = new Error('cancelled at ready');
    const logger = hookLogger((logged, msg) => {
      if (msg === 'startup.step' && logged === 'ready') controller.abort(reason);
    });
    const stdout = captureStream();
    const error = await failureOf(startRuntimeProcess({ home: temp.home, version: RUNTIME_VERSION, logger, stdout, signal: controller.signal }));
    expect(error).toBe(reason);
    expect(stepsLogged(logger)).toEqual([...STARTUP_STEPS]);
    expect(stepsLogged(logger, 'teardown.step')).toEqual(['timers', 'workers', 'service', 'cancel-upstream', 'mcp-pools', 'background-jobs', 'gateway-client', 'telemetry', 'trace-store', 'store', 'lock']);
    expect(stdout.chunks).toEqual([]);
    expect(entriesNamed(logger, 'runtime ready')).toEqual([]);
    expect(await isLockFree(temp.paths.locks.runtime)).toBe(true);
  });

  it('a signal aborted after ready has no effect', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack();
    const controller = new AbortController();
    const launched = await launchRuntime(stack.temp, { signal: controller.signal });
    controller.abort(new Error('too late'));
    await afterMicrotasks();
    const health = await launched.http('GET', '/v1/health');
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ state: 'running' });
    expect(stepsLogged(launched.logger, 'teardown.step')).toEqual([]);
    expect(await isLockFree(stack.temp.paths.locks.runtime)).toBe(false);
  });

  it('the abort reason is not mapped to a config or lock class', PROCESS_TIMEOUT, async () => {
    const temp = sandboxNoneHome();
    const plain = new AbortController();
    plain.abort();
    const defaultReason = plain.signal.reason as unknown;
    const first = await failureOf(startBare(temp, { signal: plain.signal }).started);
    expect(first).toBe(defaultReason);
    expect(first).toMatchObject({ name: 'AbortError' });
    expect(first).not.toBeInstanceOf(ConfigError);
    expect(first).not.toBeInstanceOf(ProcessLockHeldError);

    const controller = new AbortController();
    const reason = new Error('cancelled at settings');
    const logger = hookLogger((logged, msg) => {
      if (msg === 'startup.step' && logged === 'settings') controller.abort(reason);
    });
    const second = await failureOf(startRuntimeProcess({ home: temp.home, version: RUNTIME_VERSION, logger, stdout: captureStream(), signal: controller.signal }));
    expect(second).toBe(reason);
    expect(second).not.toBeInstanceOf(ConfigError);
    expect(second).not.toBeInstanceOf(ProcessLockHeldError);
  });
});
