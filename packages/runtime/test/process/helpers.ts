import fs from 'node:fs';
import path from 'node:path';
import { afterEach } from 'vitest';
import { createUserSettingsCache, diskKeptRecords, keptSettingsDirectory } from '@momonga/config';
import type { UserSettingsCache } from '@momonga/config';
import { DEFAULT_STOP_VALUES, FIRST_GENERATION, mcpPoolCloseBoundMs, claimPathOf, ensureMomongaDirs, fixedRolePort, hostKernelLock, momongaPaths, nodeFileSystemSync } from '@momonga/foundation';
import type { JsonLogger, LogFields, MomongaPaths, ReapTiming, RolePort, SessionScratch } from '@momonga/foundation';
import type { McpPool, McpPoolOptions } from '@momonga/mcp';
import * as runtime from '@momonga/runtime';
import type { RunNotifier, SettingsComposition, ToolRuntime } from '@momonga/runtime';
import type { Sandbox, SandboxPolicy } from '@momonga/sandbox';
import { openRuntimeStore } from '@momonga/store';
import type { RuntimeStore, Session } from '@momonga/store';
import { FAKE_LEASE, UNBOUNDED_OUTPUT_FIT, UNCONFIGURED_NETWORK, createFakeClock, createFakeTimers, createTempDir, driveFakeTime, fakeReapTiming, killGroupsForCleanup, modelSettings, removeTempDir, NEVER_CANCELLED } from '@momonga/testkit';
import { nodeShellHost } from '@momonga/tools';
import type { FakeClock, FakeTimers } from '@momonga/testkit';
import { fixedSandboxBindings } from '@momonga/runtime';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';

export const START_MS = 1_800_000_000_000;
export const DECLARED_CREDENTIAL = 'FM_UPSTREAM_VALUE';
export const POOL_IDLE_CLOSE_MS = 300_000;
export const POOL_REFERENCE_AUDIT_MS = 300_000;
export const SESSION_STATE_IDLE_MS = 1_800_000;

type Cleanup = () => void | Promise<void>;

const cleanups: Cleanup[] = [];

afterEach(async () => {
  const pending = cleanups.splice(0).reverse();
  const errors: unknown[] = [];
  for (const cleanup of pending) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
});

export const onCleanup = (cleanup: Cleanup): void => void cleanups.push(cleanup);

export type TempHome = { root: string; home: string; paths: MomongaPaths; project: string; dbPath: string };

export const makeTempHome = async (): Promise<TempHome> => {
  const root = createTempDir();
  onCleanup(() => removeTempDir(root));
  const home = createTempDir({ asHome: true });
  onCleanup(() => removeTempDir(home));
  const paths = momongaPaths(home, process.platform, {});
  await ensureMomongaDirs(paths);
  const project = path.join(root, 'p');
  fs.mkdirSync(project);
  return { root, home, paths, project, dbPath: path.join(root, 's.db') };
};

export const makeDir = (base: string, ...parts: string[]): string => {
  const directory = path.join(base, ...parts);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
};

export const writeJson = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(staging, file);
};

export const writeUserSettings = (home: string, value: unknown): void => writeJson(path.join(home, '.momonga', 'settings.json'), value);

export const writeInvalidUserSettings = (home: string): void => {
  const file = path.join(home, '.momonga', 'settings.json');
  const staging = `${file}.invalid.tmp`;
  fs.writeFileSync(staging, '{ "permissions": { "defaultMode": 42 }, "unexpected": [ ');
  fs.renameSync(staging, file);
};

export const writeProjectSettings = (projectDir: string, value: unknown): void => writeJson(path.join(projectDir, '.momonga', 'settings.json'), value);

export const chatTargetSettings = (apiKeyEnv: string): Record<string, unknown> =>
  modelSettings({ models: [{ provider: 'fake', id: 'x', baseUrl: 'https://api.example.com/v1', apiKeyEnv, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }] });

export type CountingCache = UserSettingsCache & { snapshots: number };

export const makeCache = (home: string): CountingCache => {
  const inner = createUserSettingsCache({ home, onWarning: () => undefined, keptRecords: diskKeptRecords(nodeFileSystemSync, keptSettingsDirectory(home)) });
  const cache: CountingCache = {
    snapshots: 0,
    get: () => inner.get(),
    kept: inner.kept,
    read: () => {
      cache.snapshots += 1;
      return inner.read();
    },
    snapshot: () => {
      cache.snapshots += 1;
      return inner.snapshot();
    },
  };
  return cache;
};

export type StoreFixture = { store: RuntimeStore; notifier: RunNotifier; clock: FakeClock; timers: FakeTimers };

export const openStore = (temp: TempHome, clock: FakeClock = createFakeClock(START_MS)): StoreFixture => {
  const notifier = runtime.createRunNotifier();
  const store = openRuntimeStore({ unaskedCommands: UNASKED_COMMANDS,
    path: temp.dbPath,
    home: temp.home,
    clock,
    leaseMs: 30_000,
    maxAttempts: 5,
    maxTotalAttempts: 50,
    onCommit: (touched) => notifier.onCommit(touched),
  });
  onCleanup(() => store.close());
  return { store, notifier, clock, timers: createFakeTimers(clock) };
};

export const createSession = (
  store: RuntimeStore,
  cwd: string,
  extra: { env?: Record<string, string>; additionalDirectories?: readonly string[]; mcpServers?: Record<string, Record<string, unknown>> } = {},
): Session =>
  store.createSession({
    cwd,
    env: extra.env ?? {},
    permissionMode: 'manual',
    model: 'default',
    ...(extra.additionalDirectories === undefined ? {} : { additionalDirectories: extra.additionalDirectories }),
    ...(extra.mcpServers === undefined ? {} : { mcpServers: extra.mcpServers }),
  });

export const createRun = (store: RuntimeStore, sessionId: string): string => {
  const result = store.createRunAndEnqueue(sessionId, { input: 'hello', timeoutMs: 3_600_000, limits: {}, pins: {} }) as { run?: { id: string } };
  const id = result.run?.id;
  if (id === undefined) throw new Error(`run was not created: ${JSON.stringify(result)}`);
  return id;
};

export const fenceFor = (store: RuntimeStore, runId: string, workerId = 'batch-worker'): { runId: string; workerId: string; leaseToken: number } => {
  const run = store.getRun(runId);
  if (run === undefined) throw new Error(`unknown run ${runId}`);
  if (run.status === 'QUEUED') {
    const claim = store.claim(workerId);
    if (claim === null || claim.runId !== runId) throw new Error(`${workerId} could not claim run ${runId}`);
    return { runId, workerId, leaseToken: claim.leaseToken };
  }
  if (run.leaseOwner === null) throw new Error(`run ${runId} holds no lease`);
  return { runId, workerId: run.leaseOwner, leaseToken: run.leaseToken };
};

export type LogEntry = { level: 'debug' | 'info' | 'warn' | 'error'; msg: string; fields: LogFields | undefined };

export type RecordingLogger = JsonLogger & { entries: LogEntry[] };

export const makeLogger = (): RecordingLogger => {
  const entries: LogEntry[] = [];
  const record = (level: LogEntry['level']) => (msg: string, fields?: LogFields) => void entries.push({ level, msg, fields });
  return { entries, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
};

export type Reporter = { report(error: unknown): void; errors: unknown[] };

export const makeReporter = (): Reporter => {
  const errors: unknown[] = [];
  return { errors, report: (error) => void errors.push(error) };
};

export type FakePool = McpPool & { closes: number; finishClose(): void; options: McpPoolOptions | undefined };

export const makeFakePool = (options?: McpPoolOptions, controlled = false): FakePool => {
  let finish: () => void = () => undefined;
  const pool: FakePool = {
    sources: [],
    closes: 0,
    options,
    diagnostics: () => [],
    finishClose: () => finish(),
    close: () => {
      pool.closes += 1;
      if (!controlled) return Promise.resolve();
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  };
  return pool;
};

export type FakePoolFactory = { create(options: McpPoolOptions): McpPool; pools: FakePool[] };

export const makeFakePoolFactory = (): FakePoolFactory => {
  const pools: FakePool[] = [];
  return {
    pools,
    create: (options) => {
      const pool = makeFakePool(options);
      pools.push(pool);
      return pool;
    },
  };
};

export const recordingReapTiming = (clock: FakeClock, timers: FakeTimers): ReapTiming & { sleeps: number[] } => {
  const timing = fakeReapTiming(clock, timers);
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => timing.now(),
    sleep: (ms) => {
      sleeps.push(ms);
      return timing.sleep(ms);
    },
  };
};

export const flushMicrotasks = async (turns = 20): Promise<void> => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

export const errnoError = (code: string, message = `${code}: injected`): NodeJS.ErrnoException => Object.assign(new Error(message), { code });

export const inertSandbox: Sandbox = {
  kind: 'seatbelt',
  spawn: () => {
    throw new Error('the inert sandbox does not spawn processes');
  },
};

export type RuntimeFixture = StoreFixture & {
  temp: TempHome;
  cache: CountingCache;
  composition: SettingsComposition;
  toolRuntime: ToolRuntime;
  logger: RecordingLogger;
  reporter: Reporter;
  pools: FakePoolFactory;
  reapTiming: ReturnType<typeof recordingReapTiming>;
};

export type RuntimeFixtureOptions = {
  temp?: TempHome;
  sandbox?: Sandbox;
  createPool?: (options: McpPoolOptions) => McpPool;
  ensureSessionTmpDir?: (paths: MomongaPaths, sessionId: string) => Promise<SessionScratch>;
  reapTiming?: ReapTiming;
  role?: RolePort;
  generation?: number;
};

export const makeRuntimeFixture = async (options: RuntimeFixtureOptions = {}): Promise<RuntimeFixture> => {
  const temp = options.temp ?? (await makeTempHome());
  const fixture = openStore(temp);
  const cache = makeCache(temp.home);
  const logger = makeLogger();
  const reporter = makeReporter();
  const pools = makeFakePoolFactory();
  const reapTiming = recordingReapTiming(fixture.clock, fixture.timers);
  const composition = runtime.createSettingsComposition({ signal: new AbortController().signal, home: temp.home, platform: process.platform, cache, store: fixture.store });
  fs.mkdirSync(temp.paths.jobs, { recursive: true, mode: 0o700 });
  const toolRuntime = runtime.createToolRuntime({
    network: UNCONFIGURED_NETWORK,
    paths: temp.paths,
    sharedPaths: temp.paths,
    generation: options.generation ?? FIRST_GENERATION,
    role: options.role ?? fixedRolePort('serving'),
    home: temp.home,
    store: fixture.store,
    notifier: fixture.notifier,
    clock: fixture.clock,
    timers: fixture.timers,
    logger,
    report: reporter.report,
    sandboxes: fixedSandboxBindings(options.sandbox ?? inertSandbox),
    shellHost: nodeShellHost(),
    settings: composition,
    reapTiming: options.reapTiming ?? reapTiming,
    ...FAKE_LEASE,
    createPool: options.createPool ?? pools.create,
    ...(options.ensureSessionTmpDir === undefined ? {} : { ensureSessionTmpDir: options.ensureSessionTmpDir }),
  });
  onCleanup(async () => {
    const graceMs = DEFAULT_STOP_VALUES.mcpCloseGraceMs;
    let closed = false;
    const closing = toolRuntime.mcpPools.closeAll(graceMs).finally(() => {
      closed = true;
    });
    await driveFakeTime(fixture.timers, { done: () => closed, horizonAt: fixture.timers.now() + mcpPoolCloseBoundMs(graceMs), description: 'the MCP pools to close at cleanup' });
    await closing;
  });
  return { ...fixture, temp, cache, composition, toolRuntime, logger, reporter, pools, reapTiming };
};

export const signalNever = (): AbortSignal => new AbortController().signal;

export const HAS_SEATBELT = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

export const BASE_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });

const spawnedGroups: number[] = [];

afterEach(async () => {
  const groups = spawnedGroups.splice(0);
  if (groups.length > 0) await killGroupsForCleanup(groups);
});

export const trackGroup = (pgid: number): void => void spawnedGroups.push(pgid);

const collect = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

export const runSandboxed = async (
  sandbox: Sandbox,
  policy: SandboxPolicy,
  command: { script: string; cwd: string; env: Readonly<Record<string, string>>; tmpDir: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', command.script], cwd: command.cwd, env: command.env, tmpDir: command.tmpDir }, policy, new AbortController().signal);
  trackGroup((await proc).pgid);
  const [stdout, stderr, exit] = await Promise.all([collect((await proc).stdout), collect((await proc).stderr), (await proc).exited]);
  return { code: exit.code, stdout, stderr };
};

export const runBashThroughPort = async (
  f: RuntimeFixture,
  session: Session,
  runId: string,
  command: string,
  mode: 'manual' | 'bypassPermissions' = 'bypassPermissions',
  options: { fence?: { runId: string; workerId: string; leaseToken: number }; callId?: string } = {},
) => {
  const port = f.toolRuntime.port;
  const signal = signalNever();
  const env = port.envFor(session);
  const binding = (await port.sandboxes.acquire(signal)).value;
  const policy = await port.policyFor(session, { signal: NEVER_CANCELLED, env, rules: [], ruleEnforcement: binding.ruleEnforcement });
  const toolSet = await port.toolSet(runId, { signal, env });
  const outcomes = await port.executor.runBatch({
    calls: [{ callId: options.callId ?? `call-${Math.random().toString(16).slice(2)}`, name: 'Bash', arguments: JSON.stringify({ command }) }],
    toolSet,
    fence: options.fence ?? fenceFor(f.store, runId),
    runId,
    step: 1,
    mode,
    rules: [],
    home: f.temp.home,
    roots: policy.roots,
    tmpDir: policy.tmpDir,
    env: policy.env,
    session: port.sessionState(session),
    sandbox: binding.sandbox,
    sandboxPolicy: policy.sandboxPolicy,
    ripgrep: port.ripgrepLocator(policy.env),
    deadlineAt: f.clock.now() + 120_000,
    outputFit: UNBOUNDED_OUTPUT_FIT,
    reconcileFit: UNBOUNDED_OUTPUT_FIT,
    signal,
  });
  const outcome = outcomes[0];
  if (outcome === undefined) throw new Error('no outcome');
  return { outcome, env, policy };
};

export const makeAbandonedDirectory = (directory: string): string => {
  const lock = hostKernelLock();
  const claimed = lock.claimSync?.(claimPathOf(lock, directory, 'sidecar'));
  if (claimed?.kind !== 'claimed') throw new Error(`the sidecar of ${directory} could not be claimed by the test`);
  fs.mkdirSync(directory, { recursive: true });
  claimed.lock.release();
  return directory;
};
