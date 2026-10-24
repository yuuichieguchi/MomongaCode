import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { createUdsClient, momongaPaths } from '@momonga/foundation';
import type { Clock, MomongaPaths, ReadyFields, TextStream, UdsClient } from '@momonga/foundation';
import { startGatewayProcess } from '@momonga/gateway';
import * as runtime from '@momonga/runtime';
import type { ServiceTimers } from '@momonga/runtime';
import { startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsOptions, FakeChatCompletionsServer, FakeResponseHold, FakeTimers } from '@momonga/testkit';
import { makeLogger, onCleanup, writeUserSettings } from './helpers.ts';
import type { LogEntry, RecordingLogger } from './helpers.ts';
import { openEventStream, sendJson } from '../service/helpers.ts';
import type { EventStream, JsonResponse, RequestInit } from '../service/helpers.ts';

export const RUNTIME_VERSION = '1.10.0-runtime-test';
export const GATEWAY_VERSION = '1.10.0-gateway-test';
export const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const STARTUP_STEPS = [
  'dirs',
  'lock',
  'settings',
  'sandbox',
  'mcp-markers',
  'store',
  'tool-markers',
  'tmp-sweep',
  'trace-store',
  'telemetry',
  'gateway-client',
  'ports',
  'service',
  'workers',
  'timers',
  'ready',
] as const;
export const TEARDOWN_ORDER = ['timers', 'workers', 'service', 'cancel-upstream', 'mcp-pools', 'gateway-client', 'telemetry', 'trace-store', 'store', 'lock'] as const;
export const HOUR_MS = 3_600_000;
export const FIVE_MINUTES_MS = 300_000;
export const STORE_IDENTITY_CHECK_MS = 5000;
export const ABORT_BUDGET_MS = 5000;
export const TEARDOWN_BUDGET_MS = 10_000;
export const CANCEL_SETTLE_MS = 1000;

export type SandboxKind = 'seatbelt' | 'none';

export type RuntimeCloseResult = { clean: boolean; fatal?: Error; abandoned: string[]; stragglers: string[] };

export type RuntimeProcess = {
  ready: ReadyFields;
  sandbox: SandboxKind;
  close(): Promise<RuntimeCloseResult>;
  abort(): Promise<RuntimeCloseResult>;
  fatal: Promise<Error>;
};

export type StartRuntimeProcessOptions = {
  home: string;
  version: string;
  clock?: Clock;
  timers?: ServiceTimers;
  logger?: RecordingLogger;
  stdout?: TextStream;
  gatewaySocketPath?: string;
  sandboxExecPath?: string;
  workerCount?: number;
  leaseMs?: number;
  drainTimeoutMs?: number;
  signal?: AbortSignal;
};

const exported = <T>(name: string): T => {
  const value = (runtime as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`@momonga/runtime does not export ${name}`);
  return value as T;
};

export const startRuntimeProcess = (options: StartRuntimeProcessOptions): Promise<RuntimeProcess> =>
  exported<(options: StartRuntimeProcessOptions) => Promise<RuntimeProcess>>('startRuntimeProcess')(options);

export const runtimeAlreadyRunningError = (): abstract new (...args: never[]) => Error =>
  exported<abstract new (...args: never[]) => Error>('RuntimeAlreadyRunningError');

export type RunHome = { root: string; home: string; paths: MomongaPaths; project: string };

export const makeRunHome = (): RunHome => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mh-')));
  onCleanup(() => {
    restoreModes(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'h');
  fs.mkdirSync(home, { mode: 0o700 });
  const project = path.join(root, 'p');
  fs.mkdirSync(project);
  return { root, home, paths: momongaPaths(home, 'darwin', {}), project };
};

const restoreModes = (directory: string): void => {
  let entries: fs.Dirent[];
  try {
    fs.chmodSync(directory, 0o700);
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) restoreModes(path.join(directory, entry.name));
  }
};

export const sessionEnvFor = (tempHome: string): Readonly<Record<string, string>> => {
  const tmp = path.join(tempHome, 'session-tmp');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return Object.freeze({ HOME: tempHome, PATH: MINIMAL_PATH, TMPDIR: tmp });
};

export const modelSettings = (fakeSocketPath: string): Record<string, unknown> => ({
  models: {
    aliases: { default: ['primary'] },
    targets: {
      primary: { adapter: 'chat-completions', model: 'system', socketPath: fakeSocketPath, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } },
    },
  },
});

export type Stack = {
  temp: RunHome;
  fake: FakeChatCompletionsServer;
  hold(): FakeResponseHold;
  settings: (extra?: Record<string, unknown>) => void;
  completions(): number;
};

export const startFake = async (options: Partial<FakeChatCompletionsOptions> = {}): Promise<FakeChatCompletionsServer> => {
  const fake = await startFakeChatCompletions({ scenario: 'tools-ok', maxConcurrency: 8, ...options });
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

export const startGateway = async (temp: RunHome): Promise<void> => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  try {
    const gateway = await startGatewayProcess({ home: temp.home, env: sessionEnvFor(temp.home), version: GATEWAY_VERSION });
    onCleanup(async () => {
      await gateway.close();
    });
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

export type LaunchOptions = Omit<StartRuntimeProcessOptions, 'home' | 'version' | 'logger' | 'stdout'> & {
  logger?: RecordingLogger;
  stdout?: CapturedStdout;
  fakeTimers?: FakeTimers;
};

export const driveUntilSettled = async <T>(promise: Promise<T>, timers: FakeTimers, now: () => number, maxRounds = 400): Promise<T> => {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  for (let round = 0; round < maxRounds && !settled; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (settled) break;
    const next = [...timers.pending()].sort((a, b) => a.dueAt - b.dueAt)[0];
    if (next !== undefined) timers.advance(Math.max(0, next.dueAt - now()));
  }
  return tracked;
};

export const waitForTimer = (timers: FakeTimers, delayMs: number, description: string, exclude: ReadonlySet<number> = new Set()): Promise<void> =>
  waitForCondition(() => timers.pending().some((timer) => timer.delayMs === delayMs && !exclude.has(timer.id)), description);

export const fireTimer = async (timers: FakeTimers, delayMs: number, description: string, exclude: ReadonlySet<number> = new Set()): Promise<void> => {
  await waitForTimer(timers, delayMs, description, exclude);
  timers.advance(delayMs);
  await flushTurns();
};

export const timerIds = (timers: FakeTimers): ReadonlySet<number> => new Set(timers.pending().map((timer) => timer.id));

export const fireDuringTeardownStep = async (logger: RecordingLogger, timers: FakeTimers, step: string, delayMs: number): Promise<void> => {
  await waitForCondition(() => stepsLogged(logger, 'teardown.step').includes(step), `teardown step ${step}`);
  await fireTimer(timers, delayMs, `the ${step} timer`);
};

export const launchRuntime = async (temp: RunHome, options: LaunchOptions = {}): Promise<Launched> => {
  const { fakeTimers, logger: givenLogger, stdout: givenStdout, ...rest } = options;
  const logger = givenLogger ?? makeLogger();
  const stdout = givenStdout ?? captureStream();
  const handle = await startRuntimeProcess({
    home: temp.home,
    version: RUNTIME_VERSION,
    logger,
    stdout,
    ...(fakeTimers === undefined ? {} : { timers: fakeTimers }),
    ...rest,
  });
  onCleanup(async () => {
    const closing = handle.abort();
    const clock = rest.clock;
    if (fakeTimers === undefined || clock === undefined) await closing;
    else await driveUntilSettled(closing, fakeTimers, () => clock.now());
  });
  return { handle, logger, stdout, ...clientOf(temp) };
};

export const clientOf = (temp: RunHome) => {
  const client = createUdsClient(temp.paths.sockets.runtime);
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

export const isLockFree = (lockPath: string): boolean => {
  if (!fs.existsSync(lockPath)) return true;
  const content = fs.readFileSync(lockPath, 'utf8').trim();
  return content !== String(process.pid);
};

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

export const waitForCondition = async (predicate: () => boolean, description: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};

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
  for (let turn = 0; turn < 10; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  return settled ? 'settled' : 'pending';
};

export const flushTurns = async (turns = 10): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

export const eventTypes = (temp: RunHome, runId: string): string[] =>
  readDb<{ type: string }>(temp.paths.databases.runtime, 'SELECT type FROM events WHERE run_id = ? ORDER BY seq', runId).map((row) => row.type);

export const recordPgid = (temp: RunHome): number | undefined =>
  readDb<{ pgid: number | null }>(temp.paths.databases.runtime, 'SELECT pgid FROM idempotency WHERE pgid IS NOT NULL').map((row) => row.pgid ?? undefined)[0];

export const scriptedToolCall = (name: string, args: Record<string, unknown>, callId = 'call_1') => ({
  kind: 'stream' as const,
  chunks: [
    {
      delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finishReason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
