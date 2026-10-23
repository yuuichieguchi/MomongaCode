import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { parseRule } from '@momonga/config';
import type { McpServerConfig, McpServerEntry, PermissionRule, RuleEffect } from '@momonga/config';
import { createMcpPool, type McpPool } from '@momonga/mcp';
import { createToolExecutor, createToolRegistry } from '@momonga/tools';
import type { BatchInput, BlobPort, IdempotencyPort, ToolCall, ToolIdempotencyBegin, ToolIdempotencyRecord, ToolSet } from '@momonga/tools';
import { MCP_LEGACY_SERVER_PATH, MCP_MODERN_SERVER_PATH, MODERN_FIXTURE_RECORD_ENV, createFakeClock, killPidsForCleanup, type FakeClock, type ModernFixtureRecord } from '@momonga/testkit';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'test cleanup failed');
});

export const onCleanup = (cleanup: () => Promise<void> | void): void => {
  cleanups.push(cleanup);
};

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const groupExists = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const makeDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-src-')));
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const readRecords = (file: string): ModernFixtureRecord[] => {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ModernFixtureRecord);
};

export const makeRecordFile = (): string => {
  const file = path.join(makeDir(), 'record.jsonl');
  onCleanup(() => {
    for (const entry of readRecords(file)) {
      if ((entry.type === 'grandchild' || entry.type === 'ready') && entry.pid > 1 && pidAlive(entry.pid)) killPidsForCleanup([entry.pid]);
    }
  });
  return file;
};

export const waitUntil = async (condition: () => boolean, description: string, limitMs = 10_000): Promise<void> => {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > limitMs) throw new Error(`condition not reached: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

export const waitForRecord = async (file: string, predicate: (entry: ModernFixtureRecord) => boolean): Promise<ModernFixtureRecord> => {
  await waitUntil(() => readRecords(file).some(predicate), `record in ${file}`);
  return readRecords(file).find(predicate) as ModernFixtureRecord;
};

export const listRecordCount = (file: string): number => readRecords(file).filter((entry) => entry.type === 'list').length;

export const callRecords = (file: string, tool: string): ModernFixtureRecord[] =>
  readRecords(file).filter((entry) => entry.type === 'call' && entry.tool === tool);

export const BASE_ENV: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), USER: 'fixture-user' };

export const modernConfig = (recordFile: string, env: Record<string, string> = {}): McpServerConfig => ({
  command: process.execPath,
  args: [MCP_MODERN_SERVER_PATH],
  env: { [MODERN_FIXTURE_RECORD_ENV]: recordFile, ...env },
});

export const legacyConfig = (): McpServerConfig => ({ command: process.execPath, args: [MCP_LEGACY_SERVER_PATH] });

export const entry = (name: string, config: McpServerConfig): McpServerEntry => ({ name, scope: 'user', config });

export type PoolHarness = {
  pool: McpPool;
  clock: FakeClock;
  projectDir: string;
  snapshot(): Promise<ToolSet>;
};

export const makePool = (
  servers: McpServerEntry[],
  options: { requestTimeoutMs?: number; resetAfterMs?: number; connectTimeoutMs?: number; random?: () => number; clock?: FakeClock } = {},
): PoolHarness => {
  const clock = options.clock ?? createFakeClock(1_000_000);
  const projectDir = makeDir();
  const pool = createMcpPool({
    servers,
    projectDir,
    baseEnv: BASE_ENV,
    clock,
    random: options.random ?? (() => 0),
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.resetAfterMs === undefined ? {} : { resetAfterMs: options.resetAfterMs }),
  });
  onCleanup(() => pool.close());
  const registry = createToolRegistry();
  for (const source of pool.sources) registry.addSource(source);
  return { pool, clock, projectDir, snapshot: () => registry.snapshot() };
};

const makeIdempotency = (): IdempotencyPort => {
  const completed = new Map<string, unknown>();
  const open = new Map<string, ToolIdempotencyRecord>();
  return {
    get: (key) => {
      if (completed.has(key)) return { s: 'COMPLETED', result: completed.get(key) };
      const rec = open.get(key);
      if (rec === undefined) return undefined;
      return rec.state === 'UNKNOWN' ? { s: 'UNKNOWN', rec } : { s: 'PENDING', rec };
    },
    begin: (key, beginOptions): ToolIdempotencyBegin => {
      if (completed.has(key)) return { s: 'COMPLETED', result: completed.get(key) };
      const rec = open.get(key);
      if (rec !== undefined) return rec.state === 'UNKNOWN' ? { s: 'UNKNOWN', rec } : { s: 'PENDING', rec };
      open.set(key, { key, state: 'PENDING', meta: beginOptions.meta, createdAt: 0, expiresAt: beginOptions.expiresAt });
      return { s: 'NEW' };
    },
    attachProcess: () => undefined,
    complete: (key, result) => {
      open.delete(key);
      completed.set(key, result);
    },
    markUnknown: (key) => {
      const rec = open.get(key);
      if (rec !== undefined) open.set(key, { ...rec, state: 'UNKNOWN' });
    },
  };
};

const unusedBlobs: BlobPort = {
  put: () => {
    throw new Error('blobs are not used by MCP tests');
  },
  read: () => Promise.reject(new Error('blobs are not used by MCP tests')),
};

const unusedSandbox: BatchInput['sandbox'] = {
  kind: 'seatbelt',
  spawn: () => {
    throw new Error('sandbox is not used by MCP tests');
  },
};

let runCounter = 0;

export const makeExecutor = (clock: FakeClock = createFakeClock(1_000_000)) => {
  const root = makeDir();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const markers = path.join(root, 'markers');
  for (const dir of [home, project]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(markers, { mode: 0o700 });
  const executor = createToolExecutor({
    idempotency: makeIdempotency(),
    blobs: unusedBlobs,
    clock,
    processMarkerDir: markers,
    readOnlyRetry: { attempts: 3, baseMs: 0, maxMs: 0 },
  });
  const rule = (effect: RuleEffect, text: string): PermissionRule =>
    parseRule(text, { effect, origin: 'user', source: 'user-settings', settingsRoot: project, home, cwd: project });
  const input = (toolSet: ToolSet, calls: ToolCall[], extra: Partial<BatchInput> = {}): BatchInput => {
    runCounter += 1;
    return {
      calls,
      toolSet,
      runId: `run-${runCounter}`,
      step: 1,
      mode: 'default',
      rules: [],
      home,
      roots: [project],
      env: {},
      session: { cwd: project, readLedger: new Map() },
      sandbox: unusedSandbox,
      sandboxPolicy: { writableRoots: [project], writeDenied: [], readDenied: [], network: 'deny' },
      deadlineAt: clock.now() + 600_000,
      signal: new AbortController().signal,
      protectedPaths: [],
      ...extra,
    };
  };
  const run = async (toolSet: ToolSet, name: string, args: unknown, extra: Partial<BatchInput> = {}) => {
    const rules = extra.rules ?? [rule('allow', name)];
    const [outcome] = await executor.runBatch(input(toolSet, [{ callId: 'call-1', name, arguments: args }], { ...extra, rules }));
    return outcome;
  };
  const resultOf = async (toolSet: ToolSet, name: string, args: unknown, extra: Partial<BatchInput> = {}) => {
    const outcome = await run(toolSet, name, args, extra);
    if (outcome?.kind !== 'result') throw new Error(`expected a result for ${name}, got ${JSON.stringify(outcome)}`);
    return outcome.result;
  };
  return { executor, clock, rule, input, run, resultOf, project, home };
};
