import type { RuleSolverSource } from '../../src/process/rule-verifier.ts';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { DEFAULT_STOP_VALUES, createUdsClient, ensureMomongaDirs, fixedRolePort, generationLayout, inspectProcessLock, momongaPaths, FIRST_GENERATION, fixedSocket, scopeToGeneration } from '@momonga/foundation';
import type { Clock, GenerationRole, JsonLogger, MomongaPaths, ReadyFields, RolePort, StopValues, TextStream, UdsClient, LayoutLocks } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import * as runtime from '@momonga/runtime';
import type { ServiceTimers } from '@momonga/runtime';
import type { McpAuthorizingPool, McpPoolOptions } from '@momonga/mcp';
import type { ShellHost } from '@momonga/tools';
import { afterMicrotasks, driveFakeTime, fakeUsageOfRequest, modelSettings as settingsOfModels, startFakeChatCompletions, firstGeneration, createTempDir, prepareGenerationForTest, registerOwned, removeTempDir, testLocks, testKernelLock, pollUntil } from '@momonga/testkit';
import type { ModelSpec } from '@momonga/testkit';

import type { FakeChatCompletionsOptions, FakeChatCompletionsServer, FakeFixedUsage, FakeResponseHold, FakeTimers, FakeUsageOfRequest } from '@momonga/testkit';
import { makeLogger, onCleanup, writeUserSettings } from './helpers.ts';
import type { LogEntry, RecordingLogger } from './helpers.ts';
import { openEventStream, sendJson } from '../service/helpers.ts';
import type { EventStream, JsonResponse, RequestInit } from '../service/helpers.ts';

const SCRIPTED_COMPLETION_TOKENS = 5;

export const RUNTIME_VERSION ='1.10.0-runtime-test';
export const GATEWAY_VERSION = '1.10.0-gateway-test';
export const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const STARTUP_STEPS = [
  'dirs',
  'role',
  'lock',
  'settings',
  'sandbox',
  'mcp-markers',
  'store',
  'tool-markers',
  'trace-store',
  'telemetry',
  'gateway-client',
  'ports',
  'background-jobs',
  'service',
  'workers',
  'timers',
  'ready',
] as const;
export const TEARDOWN_ORDER = ['timers', 'workers', 'service', 'cancel-upstream', 'mcp-pools', 'background-jobs', 'tool-markers', 'gateway-client', 'telemetry', 'trace-store', 'store', 'lock'] as const;
export const HOUR_MS = 3_600_000;
export const FIVE_MINUTES_MS = 300_000;
export const STORE_IDENTITY_CHECK_MS = 5000;
export const ABORT_BUDGET_MS = 8050;
export const TEARDOWN_BUDGET_MS = 10_000;
export const CANCEL_SETTLE_MS = 1000;

export type SandboxKind = 'seatbelt' | 'none';

export type RuntimeCloseResult = { clean: boolean; fatal?: Error; abandoned: string[]; stragglers: string[]; exitCode?: number };

export type RuntimeProcess = {
  ready: ReadyFields;
  sandbox: SandboxKind;
  close(values?: StopValues): Promise<RuntimeCloseResult>;
  abort(values?: StopValues): Promise<RuntimeCloseResult>;
  role(): GenerationRole;
  fatal: Promise<Error>;
};

export type StartRuntimeProcessOptions = {
  ruleSolver?: RuleSolverSource;
  locks?: LayoutLocks;
  home: string;
  generation: number;
  version: string;
  clock?: Clock;
  timers?: ServiceTimers;
  logger?: RecordingLogger;
  stdout?: TextStream;
  gatewaySocketPath?: string;
  sandboxExecPath?: string;
  shellHost?: ShellHost;
  platform?: NodeJS.Platform;
  workerCount?: number;
  leaseMs?: number;
  signal?: AbortSignal;
  role?: RolePort;
  requestShutdown?: () => void;
  createAdminPool?: (options: McpPoolOptions) => McpAuthorizingPool;
};

const exported = <T>(name: string): T => {
  const value = (runtime as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`@momonga/runtime does not export ${name}`);
  return value as T;
};

export const startRuntimeProcessUnprepared = (options: StartRuntimeProcessOptions): Promise<RuntimeProcess> =>
  exported<(options: StartRuntimeProcessOptions) => Promise<RuntimeProcess>>('startRuntimeProcess')({ role: fixedRolePort('serving'), locks: testLocks(), ...options });

export const startRuntimeProcess = async (options: StartRuntimeProcessOptions): Promise<RuntimeProcess> => {
  if (path.isAbsolute(options.home) && options.signal?.aborted !== true) {
    await ensureMomongaDirs(momongaPaths(options.home, process.platform, {}));
    prepareGenerationForTest(options.home, options.generation, options.version);
  }
  return startRuntimeProcessUnprepared(options);
};

export const runtimeAlreadyRunningError = (): abstract new (...args: never[]) => Error =>
  exported<abstract new (...args: never[]) => Error>('RuntimeAlreadyRunningError');

export type RunHome = { root: string; home: string; paths: MomongaPaths; project: string };

export const makeRunHome = (): RunHome => {
  const root = createTempDir();
  onCleanup(() => removeTempDir(root));
  const home = createTempDir({ asHome: true });
  onCleanup(() => removeTempDir(home));
  const project = path.join(root, 'p');
  fs.mkdirSync(project);
  return { root, home, paths: momongaPaths(home, process.platform, {}), project };
};

export const sessionEnvFor = (tempHome: string): Readonly<Record<string, string>> => {
  const tmp = path.join(tempHome, 'session-tmp');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return Object.freeze({ HOME: tempHome, PATH: MINIMAL_PATH, TMPDIR: tmp });
};

const TARGET_CONTEXT_WINDOW = 8192;

export const STACK_MODEL = 'fake/system';

export const modelSettings = (fakeSocketPath: string, contextWindow: number = TARGET_CONTEXT_WINDOW, overrides: ModelSpec = {}): Record<string, unknown> =>
  settingsOfModels({ models: [{ provider: 'fake', id: 'system', socketPath: fakeSocketPath, capabilities: { contextWindow, maxOutputTokens: 1024 }, ...overrides }] });

export type Stack = {
  temp: RunHome;
  fake: FakeChatCompletionsServer;
  hold(): FakeResponseHold;
  settings: (extra?: Record<string, unknown>) => void;
  completions(): number;
};

export const startFake = async (options: Partial<FakeChatCompletionsOptions> = {}): Promise<FakeChatCompletionsServer> => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', maxConcurrency: 8, contextWindow: TARGET_CONTEXT_WINDOW, ...options });
  onCleanup(() => fake.close());
  return fake;
};

export type FakeOptionsInput = Partial<FakeChatCompletionsOptions> | ((temp: RunHome) => Partial<FakeChatCompletionsOptions>);

export const prepareStack = async (fakeOptions: FakeOptionsInput = {}, extraSettings: Record<string, unknown> = {}): Promise<Stack> => {
  const temp = makeRunHome();
  const fake = await startFake(typeof fakeOptions === 'function' ? fakeOptions(temp) : fakeOptions);
  const hold = (): FakeResponseHold => {
    const held = fake.hold();
    onCleanup(() => held.release());
    return held;
  };
  const settings = (extra: Record<string, unknown> = extraSettings): void =>
    writeUserSettings(temp.home, { sandbox: 'none', ...modelSettings(fake.socketPath), ...extra });
  settings();
  return { temp, fake, hold, settings, completions: () => fake.requests.filter((request) => request.path === '/v1/chat/completions').length };
};

export type StartGatewayOptions = { env?: Readonly<Record<string, string>>; logger?: JsonLogger };

export const prepareGeneration = async (temp: RunHome, generation: number = FIRST_GENERATION, version: string = RUNTIME_VERSION): Promise<void> => {
  await ensureMomongaDirs(temp.paths);
  prepareGenerationForTest(temp.home, generation, version);
};

export const scopedPaths = (temp: RunHome, generation: number = FIRST_GENERATION): MomongaPaths => scopeToGeneration(temp.paths, generation);

export const startGateway = async (temp: RunHome, options: StartGatewayOptions = {}): Promise<void> => {
  await prepareGeneration(temp);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  try {
    await registerOwned(onCleanup, () => startGatewayProcess({
      locks: testLocks(),
      generation: FIRST_GENERATION,
      home: temp.home,
      env: { ...sessionEnvFor(temp.home), ...options.env },
      version: GATEWAY_VERSION,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }));
  } finally {
    stdout.mockRestore();
  }
};

export const startStack = async (fakeOptions: FakeOptionsInput = {}, extraSettings: Record<string, unknown> = {}): Promise<Stack> => {
  const stack = await prepareStack(fakeOptions, extraSettings);
  await startGateway(stack.temp);
  return stack;
};

export type CapturedStdout = TextStream & { chunks: string[]; lines(): string[] };

export const captureStream = (): CapturedStdout => {
  const chunks: string[] = [];
  return {
    chunks,
    write: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    lines: () => chunks.join('').split('\n').filter((line) => line !== ''),
  };
};

export type Launched = {
  handle: RuntimeProcess;
  logger: RecordingLogger;
  stdout: CapturedStdout;
  client: UdsClient;
  http(method: string, target: string, init?: RequestInit): Promise<JsonResponse>;
  createSession(body?: Record<string, unknown>): Promise<any>;
  createRun(sessionId: string, body?: Record<string, unknown>): Promise<any>;
  stream(target: string): Promise<EventStream>;
};

export type LaunchOptions = Omit<StartRuntimeProcessOptions, 'home' | 'generation' | 'version' | 'logger' | 'stdout'> & {
  generation?: number;
  logger?: RecordingLogger;
  stdout?: CapturedStdout;
  fakeTimers?: FakeTimers;
  drainTimeoutMs?: number;
  mcpCloseGraceMs?: number;
};

export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_CLOSE_GRACE_MS = 1000;

export const stopValuesOf = (drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS, mcpCloseGraceMs = DEFAULT_MCP_CLOSE_GRACE_MS): StopValues => ({
  ...DEFAULT_STOP_VALUES,
  drainTimeoutMs,
  mcpCloseGraceMs,
});

const abortHorizonMs = (values: StopValues): number => ABORT_BUDGET_MS + TEARDOWN_BUDGET_MS + 6 * values.mcpCloseGraceMs + 10_125;

export const driveUntilSettled = async <T>(promise: Promise<T>, timers: FakeTimers, horizonMs: number, description: string): Promise<T> => {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  await driveFakeTime(timers, { done: () => settled, horizonAt: timers.now() + horizonMs, description });
  return tracked;
};

export const waitForTimer = (timers: FakeTimers, delayMs: number, description: string, exclude: ReadonlySet<number> = new Set()): Promise<void> =>
  waitForCondition(() => timers.pending().some((timer) => timer.delayMs === delayMs && !exclude.has(timer.id)), description);

export const fireTimer = async (timers: FakeTimers, delayMs: number, description: string, exclude: ReadonlySet<number> = new Set()): Promise<void> => {
  await waitForTimer(timers, delayMs, description, exclude);
  await timers.advanceAsync(delayMs);
  await afterMicrotasks();
};

export const SERVING_TICK_MS = 1000;

export const SERVING_TICKS_DRIVEN = 10;

export const passServingTime = async (timers: FakeTimers, ms: number, done: () => boolean, description: string): Promise<void> => {
  await timers.advanceAsync(ms);
  await driveFakeTime(timers, { done, horizonAt: timers.now() + SERVING_TICKS_DRIVEN * SERVING_TICK_MS, description });
};

export const timerIds = (timers: FakeTimers): ReadonlySet<number> => new Set(timers.pending().map((timer) => timer.id));

export const fireDuringTeardownStep = async (logger: RecordingLogger, timers: FakeTimers, step: string, delayMs: number): Promise<void> => {
  await waitForCondition(() => stepsLogged(logger, 'teardown.step').includes(step), `teardown step ${step}`);
  await fireTimer(timers, delayMs, `the ${step} timer`);
};

export const launchRuntime = async (temp: RunHome, options: LaunchOptions = {}): Promise<Launched> => {
  const { fakeTimers, logger: givenLogger, stdout: givenStdout, drainTimeoutMs, mcpCloseGraceMs, generation = FIRST_GENERATION, ...rest } = options;
  const logger = givenLogger ?? makeLogger();
  const stdout = givenStdout ?? captureStream();
  const values = stopValuesOf(drainTimeoutMs, mcpCloseGraceMs);
  const abortAtCleanup = async (process: RuntimeProcess): Promise<void> => {
    const closing = process.abort(values);
    if (fakeTimers === undefined || rest.clock === undefined) await closing;
    else await driveUntilSettled(closing, fakeTimers, abortHorizonMs(values), 'the runtime abort at cleanup');
  };
  const started = await registerOwned(
    onCleanup,
    () =>
      startRuntimeProcess({
        home: temp.home,
        generation,
        version: RUNTIME_VERSION,
        logger,
        stdout,
        ...(fakeTimers === undefined ? {} : { timers: fakeTimers }),
        ...rest,
      }),
    abortAtCleanup,
  );
  const handle: RuntimeProcess = { ...started, close: (given = values) => started.close(given), abort: (given = values) => started.abort(given) };
  return { handle, logger, stdout, ...clientOf(temp, generation) };
};

export const clientOf = (temp: RunHome, generation: number = FIRST_GENERATION) => {
  const client = createUdsClient(fixedSocket(generationLayout(temp.home, generation).sockets.runtime), { connectTimeoutMs: 0 });
  onCleanup(() => client.close());
  const http = (method: string, target: string, init?: RequestInit): Promise<JsonResponse> => sendJson(client, method, target, init);
  const createSession = async (body: Record<string, unknown> = {}): Promise<any> => {
    const response = await http('POST', '/v1/sessions', { body: { cwd: temp.project, env: sessionEnvFor(temp.home), ...body } });
    if (response.status !== 201) throw new Error(`session creation failed with ${response.status}: ${response.text}`);
    return response.json.session;
  };
  const createRun = async (sessionId: string, body: Record<string, unknown> = {}): Promise<any> => {
    const response = await http('POST', `/v1/sessions/${sessionId}/runs`, { body: { input: 'Say hello', ...body } });
    if (response.status !== 202) throw new Error(`run creation failed with ${response.status}: ${response.text}`);
    return response.json.run;
  };
  const stream = (target: string): Promise<EventStream> => openEventStream(client, target);
  return { client, http, createSession, createRun, stream };
};

export const stepsLogged = (logger: RecordingLogger, msg = 'startup.step'): string[] =>
  logger.entries.filter((entry) => entry.msg === msg).map((entry) => entry.fields?.step ?? '');

export const entriesNamed = (logger: RecordingLogger, msg: string): LogEntry[] => logger.entries.filter((entry) => entry.msg === msg);

export const hookLogger = (onStep: (step: string, msg: string) => void): RecordingLogger => {
  const base = makeLogger();
  const debug = base.debug;
  base.debug = (msg, fields) => {
    debug(msg, fields);
    if (fields?.step !== undefined) onStep(fields.step, msg);
  };
  return base;
};

export const failureOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );

export const isLockFree = async (lockPath: string): Promise<boolean> => (await inspectProcessLock(lockPath, { mechanism: testKernelLock() })).state === 'free';

export const readDb = <T>(dbPath: string, sql: string, ...params: (string | number)[]): T[] => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
};

export const runStatus = (temp: RunHome, runId: string): string | undefined =>
  readDb<{ status: string }>(temp.paths.databases.runtime, 'SELECT status FROM runs WHERE id = ?', runId)[0]?.status;

export const waitForStatus = async (temp: RunHome, runId: string, statuses: readonly string[], description = `run ${runId} to reach ${statuses.join('/')}`): Promise<string> => {
  let seen: string | undefined;
  await waitForCondition(() => {
    seen = runStatus(temp, runId);
    return seen !== undefined && statuses.includes(seen);
  }, description);
  return seen as string;
};

const CONDITION_BOUND_MS = 30_000;

export const waitForCondition = (predicate: () => boolean, description: string): Promise<void> => pollUntil(predicate, { description, boundMs: CONDITION_BOUND_MS });

export const settledState = async (promise: Promise<unknown>): Promise<'settled' | 'pending'> => {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await afterMicrotasks();
  return settled ? 'settled' : 'pending';
};

export const eventTypes = (temp: RunHome, runId: string): string[] =>
  readDb<{ type: string }>(temp.paths.databases.runtime, 'SELECT type FROM events WHERE run_id = ? ORDER BY seq', runId).map((row) => row.type);

export const recordPgid = (temp: RunHome): number | undefined =>
  readDb<{ pgid: number | null }>(temp.paths.databases.runtime, 'SELECT pgid FROM idempotency WHERE pgid IS NOT NULL').map((row) => row.pgid ?? undefined)[0];

export const scriptedToolCall = (
  name: string,
  args: Record<string, unknown>,
  callId = 'call_1',
  usage: FakeFixedUsage | FakeUsageOfRequest = (body) => fakeUsageOfRequest(body, SCRIPTED_COMPLETION_TOKENS),
) => ({
  kind: 'stream' as const,
  chunks: [
    {
      delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finishReason: 'tool_calls',
    },
  ],
  usage,
});

export const approveOnce = async (launched: Pick<Launched, 'http'>, runId: string): Promise<void> => {
  const approvals = (await launched.http('GET', `/v1/runs/${runId}/approvals`)).json.approvals as { id: string; options: { optionId: string; kind: string }[] }[];
  const approval = approvals[0];
  if (approval === undefined) throw new Error(`run ${runId} has no approval`);
  const option = approval.options.find((candidate) => candidate.kind === 'allow_once');
  if (option === undefined) throw new Error('no allow_once option');
  const response = await launched.http('POST', `/v1/approvals/${approval.id}`, { body: { optionId: option.optionId } });
  if (response.status !== 200) throw new Error(`approval failed with ${response.status}: ${response.text}`);
};

export const exportedValue = <T>(name: string): T => exported<T>(name);

export const corruptSchema = (dbPath: string, table = 'approvals'): void => {
  const db = new DatabaseSync(dbPath, { defensive: false });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA writable_schema = ON');
    const version = (db.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version;
    db.prepare('UPDATE sqlite_schema SET sql = ? WHERE name = ?').run(`CREATE TABLE ${table} (`, table);
    db.exec(`PRAGMA schema_version = ${version + 1}`);
  } finally {
    db.close();
  }
};

export const finishApprovingPrompts = async (launched: Pick<Launched, 'http'>, temp: RunHome, runId: string): Promise<string> => {
  for (let round = 0; round < 10; round += 1) {
    const status = await waitForStatus(temp, runId, ['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_HUMAN']);
    if (status !== 'WAITING_HUMAN') return status;
    await approveOnce(launched, runId);
    await waitForCondition(() => runStatus(temp, runId) !== 'WAITING_HUMAN', `run ${runId} to leave WAITING_HUMAN`);
  }
  throw new Error(`run ${runId} kept asking for approval`);
};
