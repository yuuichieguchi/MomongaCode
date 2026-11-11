import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@momonga/config';
import { createJsonLogger, createUdsClient, inspectProcessLock, systemClock, FIRST_GENERATION, fixedSocket, fixedRolePort } from '@momonga/foundation';
import type { TextStream } from '@momonga/foundation';
import { GATEWAY_CONFIG_DEFAULTS, createGateway, startGatewayProcess } from '@momonga/gateway';
import type { GatewayProcess } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers, createScriptedAdapter, registerCleanup, startFakeChatCompletions, withTempDir, registerOwned } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import { HMAC_KEY, PRIMARY, START_MS, TEST_VERSION, buildConfig, postJson, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, ccTarget, homePaths, until, writeSettings, modelsOf, prepareHome as prepareGenerationHome } from './gateway-process-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const control = vi.hoisted(() => ({
  createGatewayError: undefined as Error | undefined,
  afterCreateGateway: undefined as (() => void) | undefined,
  adapterCloseError: undefined as Error | undefined,
  minimalEnvSources: [] as unknown[],
}));

vi.mock('../src/server/gateway.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/server/gateway.ts')>();
  return {
    ...original,
    createGateway: async (options: Parameters<typeof original.createGateway>[0]) => {
      if (control.createGatewayError !== undefined) throw control.createGatewayError;
      const gateway = await original.createGateway(options);
      control.afterCreateGateway?.();
      return gateway;
    },
  };
});

vi.mock('../src/adapters/chat-completions/adapter.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/adapters/chat-completions/adapter.ts')>();
  return {
    ...original,
    createChatCompletionsAdapter: (options: Parameters<typeof original.createChatCompletionsAdapter>[0]) => {
      const adapter = original.createChatCompletionsAdapter(options);
      return {
        ...adapter,
        close: async () => {
          await adapter.close?.();
          if (control.adapterCloseError !== undefined) throw control.adapterCloseError;
        },
      };
    },
  };
});

vi.mock('@momonga/foundation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/foundation')>();
  return {
    ...original,
    minimalChildEnv: (source: Readonly<Record<string, string | undefined>>) => {
      control.minimalEnvSources.push(source);
      return original.minimalChildEnv(source);
    },
  };
});

const GRACE_MS = GATEWAY_CONFIG_DEFAULTS.closeGraceMs;

type Capture = TextStream & { lines(): string[] };

const capture = (): Capture => {
  const chunks: string[] = [];
  return {
    write: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    lines: () => chunks.join('').split('\n').filter((line) => line !== ''),
  };
};

const resetControl = (context: CleanupContext): void => {
  control.createGatewayError = undefined;
  control.afterCreateGateway = undefined;
  control.adapterCloseError = undefined;
  control.minimalEnvSources.length = 0;
  registerCleanup(context, () => {
    control.createGatewayError = undefined;
    control.afterCreateGateway = undefined;
    control.adapterCloseError = undefined;
  });
};

const prepareHome = async (context: CleanupContext) => {
  resetControl(context);
  const aux = withTempDir(context);
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', socketPath: path.join(aux, 'up.sock') });
  registerCleanup(context, () => fake.close());
  const home = withTempDir(context, { asHome: true });
  prepareGenerationHome(home);
  writeSettings(home, { models: modelsOf({ primary: ccTarget(fake.socketPath) }) });
  return { home, fake, paths: homePaths(home) };
};

const closeQuietly = async (handle: GatewayProcess): Promise<void> => {
  await handle.close().catch(() => undefined);
};

const start = async (context: CleanupContext, options: Parameters<typeof startGatewayProcess>[0]): Promise<GatewayProcess> => {
  return registerOwned(context, () => startGatewayProcess({ stdout: capture(), ...options }), closeQuietly);
};

const rejectionOf = async (started: Promise<GatewayProcess>): Promise<unknown> => {
  try {
    await started;
  } catch (error) {
    return error;
  }
  throw new Error('expected startGatewayProcess to reject, but it resolved');
};

const heldRequest = async (context: CleanupContext, fake: Awaited<ReturnType<typeof prepareHome>>['fake'], socketPath: string) => {
  const hold = fake.hold();
  registerCleanup(context, () => hold.release());
  const client = createUdsClient(fixedSocket(socketPath));
  registerCleanup(context, () => client.close());
  const request = postJson(client, '/v1/responses', { model: 'primary/system', input: userInput('hold me') }, { 'idempotency-key': 'held-through-grace' }).then(
    async (response) => response.status,
    () => 'failed' as const,
  );
  await hold.waitForRequest();
  return { settled: request };
};

const waitForGraceTimer = (timers: FakeTimers): Promise<void> =>
  until(() => timers.pending().some((timer) => timer.delayMs === GRACE_MS), `the ${GRACE_MS} ms close grace timer`);

describe('startGatewayProcess startup unwind (§4.3)', () => {
  it('startup failure rethrows the original error and logs the cleanup failure, with no AggregateError', async (context) => {
    const { home, paths } = await prepareHome(context);
    const original = new Error('createGateway failed (injected)');
    const cleanupFailure = new Error('adapter close failed (injected)');
    control.createGatewayError = original;
    control.adapterCloseError = cleanupFailure;
    const log = capture();
    const logger = createJsonLogger({ service: 'gateway', clock: systemClock, stream: log });

    const error = await rejectionOf(registerOwned(context, () => startGatewayProcess({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, logger, stdout: capture() }), closeQuietly));

    expect(error).toBe(original);
    expect(error).not.toBeInstanceOf(AggregateError);
    const cleanupLines = log.lines().map((line) => JSON.parse(line) as { msg: string; level: string; err?: { message: string } });
    const logged = cleanupLines.filter((line) => line.msg === 'startup.cleanup_failed');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'error', err: { message: cleanupFailure.message } });
    expect((await inspectProcessLock(paths.lock)).state).toBe('free');
  });

  it('ConfigError from settings is rethrown as ConfigError and the lock is released', async (context) => {
    resetControl(context);
    const home = withTempDir(context, { asHome: true });
    prepareGenerationHome(home);
    writeSettings(home, { models: modelsOf({ '9-bad-name': { adapter: 'managed', server: 'fm', model: 'system' } }) });
    const error = await rejectionOf(registerOwned(context, () => startGatewayProcess({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, stdout: capture() }), closeQuietly));
    expect(error).toBeInstanceOf(ConfigError);
    expect((await inspectProcessLock(homePaths(home).lock)).state).toBe('free');
  });

  it('the ready line goes to options.stdout and never to process.stdout', async (context) => {
    const { home } = await prepareHome(context);
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write);
    registerCleanup(context, () => spy.mockRestore());
    const stdout = capture();

    const handle = await start(context, { generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, stdout });
    spy.mockRestore();

    expect(stdout.lines()).toHaveLength(1);
    expect(JSON.parse(stdout.lines()[0] ?? '')).toEqual({
      event: 'ready',
      service: 'gateway',
      pid: process.pid,
      version: PROCESS_VERSION,
      socketPath: handle.socketPath,
      startedAt: handle.ready.startedAt,
    });
    expect(written.filter((chunk) => chunk.includes('"event":"ready"'))).toEqual([]);
  });

  it('a pre-aborted signal rejects with signal.reason and leaves no lock file', async (context) => {
    const { home, paths } = await prepareHome(context);
    const controller = new AbortController();
    const reason = new Error('cancelled before start (injected)');
    controller.abort(reason);
    const stdout = capture();

    const error = await rejectionOf(registerOwned(context, () => startGatewayProcess({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, stdout, signal: controller.signal }), closeQuietly));

    expect(error).toBe(reason);
    expect(stdout.lines()).toEqual([]);
    expect((await inspectProcessLock(paths.lock)).state).toBe('free');
  });

  it('an abort between createGateway and announceReady rejects with the reason, prints no ready line, releases the lock and closes the server', async (context) => {
    const { home, paths } = await prepareHome(context);
    const controller = new AbortController();
    const reason = new Error('cancelled after createGateway (injected)');
    control.afterCreateGateway = () => controller.abort(reason);
    const stdout = capture();

    const error = await rejectionOf(registerOwned(context, () => startGatewayProcess({ generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, stdout, signal: controller.signal }), closeQuietly));

    expect(error).toBe(reason);
    expect(stdout.lines()).toEqual([]);
    expect((await inspectProcessLock(paths.lock)).state).toBe('free');
    expect(fs.existsSync(paths.socket)).toBe(false);
  });
});

describe('GatewayProcess close and abort (§4.2, §4.3)', () => {
  it('close returns a clean result', async (context) => {
    const { home, paths } = await prepareHome(context);
    const handle = await start(context, { generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
    expect(await handle.close()).toEqual({ clean: true, abandonedRuns: 0, failures: [] });
    expect((await inspectProcessLock(paths.lock)).state).toBe('free');
  });

  it('close reports adapter failures in the result instead of rejecting', async (context) => {
    const { home } = await prepareHome(context);
    const handle = await start(context, { generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
    const failure = new Error('adapter close failed (injected)');
    control.adapterCloseError = failure;
    const result = await handle.close();
    expect(result.clean).toBe(false);
    expect(result.failures).toEqual([failure]);
    expect(result.abandonedRuns).toBe(0);
  });

  it('close reports abandonedRuns after the grace expires, and the result stays clean', async (context) => {
    const { home, fake } = await prepareHome(context);
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const handle = await start(context, { generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, clock, timers });
    const held = await heldRequest(context, fake, handle.socketPath);

    const closing = handle.close();
    await waitForGraceTimer(timers);
    timers.advance(GRACE_MS);

    expect(await closing).toEqual({ clean: true, abandonedRuns: 1, failures: [] });
    await held.settled;
  });

  it('abort cuts the grace: close in grace, then abort, both resolve without advancing the grace timer', async (context) => {
    const { home, fake } = await prepareHome(context);
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const handle = await start(context, { generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION, clock, timers });
    const held = await heldRequest(context, fake, handle.socketPath);

    const closing = handle.close();
    registerCleanup(context, async () => {
      timers.advance(GRACE_MS);
      await closing.catch(() => undefined);
    });
    await waitForGraceTimer(timers);
    const aborting = handle.abort();

    const [closed, aborted] = await Promise.all([closing, aborting]);
    expect(aborted).toBe(closed);
    expect(closed).toEqual({ clean: true, abandonedRuns: 1, failures: [] });
    expect(clock.now()).toBe(START_MS);
    await held.settled;
  });

  it('abort without close works from running', async (context) => {
    const { home, paths } = await prepareHome(context);
    const handle = await start(context, { generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
    expect(await handle.abort()).toEqual({ clean: true, abandonedRuns: 0, failures: [] });
    expect((await inspectProcessLock(paths.lock)).state).toBe('free');
    expect(fs.existsSync(paths.socket)).toBe(false);
  });

  it('close and abort are idempotent and return the same promise object', async (context) => {
    const { home } = await prepareHome(context);
    const handle = await start(context, { generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
    const first = handle.close();
    const second = handle.close();
    const aborting = handle.abort();
    expect(second).toBe(first);
    expect(aborting).toBe(first);
    expect(handle.abort()).toBe(first);
    expect(await first).toEqual({ clean: true, abandonedRuns: 0, failures: [] });
  });
});

describe('gateway fatal (§4.2, §4.3)', () => {
  it('createGateway keeps a permanent server error listener that forwards to onFatal after listen', async (context) => {
    const dir = withTempDir(context);
    const clock = createFakeClock(START_MS);
    const servers: http.Server[] = [];
    const createServer = http.createServer.bind(http);
    const spy = vi.spyOn(http, 'createServer').mockImplementation(((...args: Parameters<typeof http.createServer>) => {
      const server = createServer(...args);
      servers.push(server);
      return server;
    }) as typeof http.createServer);
    registerCleanup(context, () => spy.mockRestore());
    const seen: Error[] = [];
    const gateway = await createGateway({
      role: fixedRolePort('serving'),
      random: () => 0.5,
      credentials: [],
      config: buildConfig(),
      adapters: { [PRIMARY]: createScriptedAdapter({ calls: [] }) },
      clock,
      timers: createFakeTimers(clock),
      dbPath: path.join(dir, 'gateway.db'),
      hmacKey: HMAC_KEY,
      socketPath: path.join(dir, 'w.sock'),
      pid: process.pid,
      version: TEST_VERSION,
      onFatal: (error) => void seen.push(error),
    });
    registerCleanup(context, () => gateway.close());
    spy.mockRestore();
    const server = servers[0];
    if (server === undefined) throw new Error('the gateway created no http server');
    const first = new Error('EMFILE (injected)');
    const second = new Error('ECONNABORTED (injected)');

    expect(() => server.emit('error', first)).not.toThrow();
    expect(() => server.emit('error', second)).not.toThrow();
    expect(seen[0]).toBe(first);
    expect(seen[1]).toBe(second);
    expect(server.listening).toBe(true);
  });

  it('a server error after ready latches fatal, which triggers abort; a later close returns that same result', async (context) => {
    const { home, paths } = await prepareHome(context);
    const servers: http.Server[] = [];
    const createServer = http.createServer.bind(http);
    const spy = vi.spyOn(http, 'createServer').mockImplementation(((...args: Parameters<typeof http.createServer>) => {
      const server = createServer(...args);
      servers.push(server);
      return server;
    }) as typeof http.createServer);
    registerCleanup(context, () => spy.mockRestore());
    const handle = await start(context, { generation: FIRST_GENERATION, home, env: baseEnv(home), version: PROCESS_VERSION });
    spy.mockRestore();
    const server = servers[0];
    if (server === undefined) throw new Error('the gateway created no http server');
    const failure = new Error('server failure after listen (injected)');

    expect(() => server.emit('error', failure)).not.toThrow();

    expect(await handle.fatal).toBe(failure);
    const result = await handle.close();
    expect((await inspectProcessLock(paths.lock)).state).toBe('free');
    expect(result).toMatchObject({ clean: false, fatal: failure, failures: [] });
    expect(await handle.abort()).toBe(result);
  });
});

describe('minimalChildEnv moved to foundation (§2.3, §4)', () => {
  it('the gateway builds its child env with the foundation minimalChildEnv, from options.env as given', async (context) => {
    const { home } = await prepareHome(context);
    const env = baseEnv(home, { FOO: 'kept-out-of-children', LC_ALL: 'C' });
    await start(context, { generation: FIRST_GENERATION, home, env, version: PROCESS_VERSION });
    expect(control.minimalEnvSources).toContain(env);
  });
});
