import fs from 'node:fs';
import { compileFileRuleSet, EMPTY_PROTECTED_SET, groupAlive, HOST_FLAVOUR, nodeFileSystem, ruleEnforcementOf, syncPaths, systemRandom, momongaLayout } from '@momonga/foundation';

import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';


import { parseRule } from '@momonga/config';


import type { McpServerConfig, McpServerEntry, PermissionRule, RuleEffect } from '@momonga/config';
import { createMcpPool, type McpPool, type McpTimers } from '@momonga/mcp';


import { createToolExecutor, createToolRegistry, nodeShellHost } from '@momonga/tools';


import type { BlobPort, ExecutionBatchInput, IdempotencyPort, LeasedBegin, ToolCall, ToolIdempotencyRecord, ToolSet } from '@momonga/tools';
import { unconfiguredNetworkOf, MCP_LEGACY_SERVER_PATH, MCP_MODERN_SERVER_PATH, MODERN_FIXTURE_RECORD_ENV, createFakeClock, FAKE_LEASE, createFakeKernelLock, fakePolicyFilesystem, hostFilesystemOf, killPidsForCleanup, UNBOUNDED_OUTPUT_FIT, type FakeClock, type ModernFixtureRecord, pollUntil, testProcessInspector } from '@momonga/testkit';



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

export const groupExists = (pgid: number): Promise<boolean> => groupAlive(pgid);

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

export const waitUntil = (condition: () => boolean, description: string, limitMs = 10_000): Promise<void> => pollUntil(condition, { description, boundMs: limitMs });

export const waitForRecord = async (file: string, predicate: (entry: ModernFixtureRecord) => boolean): Promise<ModernFixtureRecord> => {
  await waitUntil(() => readRecords(file).some(predicate), `record in ${file}`);
  return readRecords(file).find(predicate) as ModernFixtureRecord;
};

export const listRecordCount = (file: string): number => readRecords(file).filter((entry) => entry.type === 'list').length;

export const callRecords = (file: string, tool: string): ModernFixtureRecord[] =>
  readRecords(file).filter((entry) => entry.type === 'call' && entry.tool === tool);

export const NEVER_ABORTED = new AbortController().signal;

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
  options: { requestTimeoutMs?: number; toolIdleTimeoutMs?: number; resetAfterMs?: number; connectTimeoutMs?: number; random?: () => number; clock?: FakeClock; timers?: McpTimers; credentialNames?: readonly string[] } = {},
): PoolHarness => {
  const clock = options.clock ?? createFakeClock(1_000_000);
  const projectDir = makeDir();
  const pool = createMcpPool({ files: nodeFileSystem,
    clientVersion: '0.0.0-test',
    servers,
    projectDir,
    baseEnv: BASE_ENV,
    clock,
    random: options.random ?? (() => 0),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.toolIdleTimeoutMs === undefined ? {} : { toolIdleTimeoutMs: options.toolIdleTimeoutMs }),
    ...(options.resetAfterMs === undefined ? {} : { resetAfterMs: options.resetAfterMs }),
    ...(options.credentialNames === undefined ? {} : { credentialNames: options.credentialNames }),
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
    processGroupOf: (key) => open.get(key)?.pgid,
    holding: () => ({
      begin: (key, beginOptions): LeasedBegin => {
        if (completed.has(key)) return { s: 'COMPLETED', result: completed.get(key) };
        const rec = open.get(key);
        if (rec !== undefined) return rec.state === 'UNKNOWN' ? { s: 'UNKNOWN', rec } : { s: 'PENDING', rec };
        open.set(key, { key, state: 'PENDING', meta: beginOptions.meta, createdAt: 0, expiresAt: beginOptions.expiresAt });
        return { s: 'NEW' };
      },
      authorise: () => ({ kind: 'ok' }),
      attachProcess: () => ({ kind: 'ok' }),
      checkpoint: (key, state) => {
        const rec = open.get(key);
        if (rec === undefined) return { kind: 'ok' };
        const { checkpoint: _previous, ...meta } = rec.meta;
        open.set(key, { ...rec, meta: state === undefined ? meta : { ...meta, checkpoint: state } });
        return { kind: 'ok' };
      },
      complete: (key, result) => {
        open.delete(key);
        completed.set(key, result);
        return { kind: 'ok' };
      },
    }),
    clearCheckpoint: (key) => {
      const rec = open.get(key);
      if (rec === undefined) return;
      const { checkpoint: _previous, ...meta } = rec.meta;
      open.set(key, { ...rec, meta });
    },
    markUnknown: (key) => {
      const rec = open.get(key);
      if (rec !== undefined) open.set(key, { ...rec, state: 'UNKNOWN' });
    },
    markUnknownIfPending: (key) => {
      const rec = open.get(key);
      if (rec?.state !== 'PENDING') return false;
      open.set(key, { ...rec, state: 'UNKNOWN' });
      return true;
    },
  };
};

const unusedBlobs: BlobPort = {
  put: () => {
    throw new Error('blobs are not used by MCP tests');
  },
  read: () => Promise.reject(new Error('blobs are not used by MCP tests')),
};

const unusedSandbox: ExecutionBatchInput['sandbox'] = {
  kind: 'seatbelt',
  spawn: () => {
    throw new Error('sandbox is not used by MCP tests');
  },
};

let runCounter = 0;

export const makeExecutor = (clock: FakeClock = createFakeClock(1_000_000), onWarning: (message: string) => void = () => undefined) => {
  const root = makeDir();
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const markers = path.join(root, 'markers');
  for (const dir of [home, project]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(markers, { mode: 0o700 });
  const callLocks = path.join(root, 'call-locks');
  fs.mkdirSync(callLocks, { mode: 0o700 });
  const executor = createToolExecutor({
    layout: momongaLayout(home, process.platform, process.env),
    reap: { inspector: testProcessInspector() },
    shellHost: nodeShellHost(),
    random: systemRandom,
    files: nodeFileSystem, outboundNetwork: unconfiguredNetworkOf, fs: hostFilesystemOf(fakePolicyFilesystem()), ...FAKE_LEASE,
    idempotency: makeIdempotency(),
    blobs: unusedBlobs,
    clock,
    processMarkerDir: markers,
    callLockDir: callLocks,
    kernelLock: createFakeKernelLock({ inheritable: false }),
    onWarning,
    readOnlyRetry: { attempts: 3, baseMs: 0, maxMs: 0 },
  });
  const rule = (effect: RuleEffect, text: string): PermissionRule =>
    parseRule(text, { effect, origin: 'user', source: 'user-settings', settingsRoot: project, home, cwd: project });
  const journalCodes = new Map<string, Set<string>>();
  const input = async (toolSet: ToolSet, calls: ToolCall[], extra: Partial<ExecutionBatchInput> = {}): Promise<ExecutionBatchInput> => {
    runCounter += 1;
    const runId = extra.runId ?? `run-${runCounter}`;
    const codes = journalCodes.get(runId) ?? new Set<string>();
    journalCodes.set(runId, codes);
    return {
      calls,
      toolSet,
      fence: { runId, workerId: 'w1', leaseToken: 1 },
      runId,
      onWarning: (_message, toolKey) => codes.add(toolKey),
      toolUnavailable: (toolKey) => codes.has(toolKey),
      step: 1,
      mode: 'manual',
      rules: [],
      home,
      roots: [project],
      env: {},
      session: { cwd: project, workingDirectory: project, readLedger: new Map() },
      sandbox: unusedSandbox,
      ripgrep: { locate: () => Promise.reject(new Error('the MCP harness runs no Grep')) },
      sandboxPolicy: { writableRoots: [project], writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: await compileFileRuleSet([], [project], null, syncPaths.resolveCanonicalPath, syncPaths.volumeIsCaseInsensitive, HOST_FLAVOUR, ruleEnforcementOf('none')), readDenied: [], network: 'deny' },
      deadlineAt: clock.now() + 600_000,
      outputFit: UNBOUNDED_OUTPUT_FIT,
      reconcileFit: UNBOUNDED_OUTPUT_FIT,
      signal: new AbortController().signal,
      ...extra,
    };
  };
  const run = async (toolSet: ToolSet, name: string, args: unknown, extra: Partial<ExecutionBatchInput> = {}) => {
    const rules = extra.rules ?? [rule('allow', name)];
    const [outcome] = await executor.runBatch(await input(toolSet, [{ callId: 'call-1', name, arguments: args }], { ...extra, rules }));
    return outcome;
  };
  const resultOf = async (toolSet: ToolSet, name: string, args: unknown, extra: Partial<ExecutionBatchInput> = {}) => {
    const outcome = await run(toolSet, name, args, extra);
    if (outcome?.kind !== 'result') throw new Error(`expected a result for ${name}, got ${JSON.stringify(outcome)}`);
    return outcome.result;
  };
  return { executor, clock, rule, input, run, resultOf, project, home };
};
