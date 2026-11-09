import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, ensureMomongaDirs, groupAlive, sha256Hex } from '@momonga/foundation';
import type { McpPoolOptions } from '@momonga/mcp';
import type { RunEventPayload } from '@momonga/protocol';
import { openRuntimeStore } from '@momonga/store';
import { REAL_PROCESS_TEST_TIMEOUT_MS, DAEMON_PROCESS_TEST_TIMEOUT_MS, MCP_MODERN_SERVER_PATH, createFakeClock } from '@momonga/testkit';
import { START_MS, trackGroup } from './helpers.ts';
import { eventTypes, launchRuntime, readDb, sessionEnvFor, startStack, waitForStatus } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const control = vi.hoisted(() => ({ watchedGroups: [] as number[], aliveAtCancel: [] as Array<Promise<boolean>>, poolsCreated: 0 }));

const groupExists = (pgid: number): Promise<boolean> => groupAlive(pgid);

vi.mock('@momonga/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/store')>();
  const { groupAlive: alive } = await import('@momonga/foundation');
  return {
    ...original,
    openRuntimeStore: (options: Parameters<typeof original.openRuntimeStore>[0]) => {
      const store = original.openRuntimeStore(options);
      return new Proxy(store, {
        get: (target, key, receiver) => {
          if (key === 'transition') {
            return (...args: Parameters<typeof target.transition>) => {
              if (args[2] === 'CANCELLED') for (const pgid of control.watchedGroups) control.aliveAtCancel.push(alive(pgid));
              return target.transition(...args);
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
    },
  };
});

vi.mock('@momonga/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/mcp')>();
  return {
    ...original,
    createMcpPool: (options: McpPoolOptions) => {
      control.poolsCreated += 1;
      return original.createMcpPool(options);
    },
  };
});

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const SEED_MS = START_MS;
const RUNTIME_MS = START_MS + 3_600_000;
const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };

beforeEach(() => {
  control.watchedGroups = [];
  control.aliveAtCancel = [];
  control.poolsCreated = 0;
});

const toolKey = (runId: string, step: number, callId: string): string => sha256Hex(canonicalJson([runId, step, callId]));

type SeedCall = { callId: string; name: string; args: Record<string, unknown>; kind: 'execute' | 'other' };

const openSeedStore = async (temp: RunHome) => {
  await ensureMomongaDirs(temp.paths);
  return openRuntimeStore({ path: temp.paths.databases.runtime, home: temp.home, clock: createFakeClock(SEED_MS), leaseMs: 30_000, maxAttempts: 5, maxTotalAttempts: 20 });
};

const seedCancellingRun = async (temp: RunHome, call: SeedCall, holderScript?: string) => {
  const store = await openSeedStore(temp);
  try {
    const session = store.createSession({ cwd: temp.project, env: { ...sessionEnvFor(temp.home) }, permissionMode: 'bypassPermissions', modelAlias: 'default', bypassAllowed: true });
    const created = store.createRunAndEnqueue(session.id, { input: 'Work', timeoutMs: 6 * 3_600_000, limits: {}, pins: {} }) as { run?: { id: string } };
    const runId = created.run?.id;
    if (runId === undefined) throw new Error('the seed run was not created');
    const key = toolKey(runId, 1, call.callId);
    const claim = store.claim('seeder');
    if (claim === null || claim.runId !== runId) throw new Error('the seeder could not claim the run');
    const payloads: RunEventPayload[] = [
      {
        type: 'model.responded',
        step: 1,
        attempt: 1,
        response: {
          status: 'completed',
          output: [{ type: 'function_call', id: `fc_${call.callId}`, call_id: call.callId, name: call.name, arguments: JSON.stringify(call.args), status: 'completed' }],
          usage: USAGE,
        },
      } as RunEventPayload,
      { type: 'tool.call', callId: call.callId, providerCallId: call.callId, name: call.name, kind: call.kind, title: call.name, rawInput: call.args } as RunEventPayload,
      { type: 'tool.started', callId: call.callId, idemKey: key } as RunEventPayload,
    ];
    if (store.append(claim, payloads).kind !== 'ok') throw new Error('the seeder lost its lease');
    store.idempotency.begin(key, { expiresAt: RUNTIME_MS + 86_400_000, meta: { tool: call.name } });
    let pgid: number | undefined;
    if (holderScript !== undefined) {
      pgid = spawnHolder(path.join(temp.paths.markers.tools, key), holderScript);
      store.idempotency.attachProcess(key, { pgid, startedAt: SEED_MS });
    }
    const cancelled = await store.requestCancel(runId);
    if (cancelled.kind !== 'ok' || cancelled.run.status !== 'CANCELLING') throw new Error('the seed run is not CANCELLING');
    return { runId, sessionId: session.id, key, pgid };
  } finally {
    store.close();
  }
};

const spawnHolder = (marker: string, script: string): number => {
  const fd = fs.openSync(marker, 'w', 0o600);
  let pid: number | undefined;
  try {
    pid = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] }).pid;
  } finally {
    fs.closeSync(fd);
  }
  if (pid === undefined) throw new Error('the marker holder did not spawn');
  trackGroup(pid);
  return pid;
};

const replaceSessionTmpWithSymlink = (temp: RunHome, sessionId: string): void => {
  const elsewhere = path.join(temp.root, `elsewhere-${sessionId}`);
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.mkdirSync(temp.paths.tmp.sessions, { recursive: true });
  fs.symlinkSync(elsewhere, path.join(temp.paths.tmp.sessions, sessionId));
};

const recordState = (temp: RunHome, key: string): string | undefined =>
  readDb<{ state: string }>(temp.paths.databases.runtime, 'SELECT state FROM idempotency WHERE key = ?', key)[0]?.state;

const reconciledOutcomes = (temp: RunHome, runId: string): string[] =>
  readDb<{ payload_json: string }>(temp.paths.databases.runtime, "SELECT payload_json FROM events WHERE run_id = ? AND type = 'tool.reconciled' ORDER BY seq", runId).map(
    (row) => (JSON.parse(row.payload_json) as { outcome: string }).outcome,
  );

const BASH: SeedCall = { callId: 'call_bash_1', name: 'Bash', args: { command: 'sleep 30' }, kind: 'execute' };

describe('cancel recovery through startRuntimeProcess (real processes, system timers)', () => {
  it('a Bash call started before the cancel is reaped before the run reaches CANCELLED', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const seeded = await seedCancellingRun(stack.temp, BASH, 'exec sleep 30');
    const pgid = seeded.pgid as number;
    replaceSessionTmpWithSymlink(stack.temp, seeded.sessionId);
    control.watchedGroups = [pgid];
    await launchRuntime(stack.temp, { clock: createFakeClock(RUNTIME_MS) });
    expect(await waitForStatus(stack.temp, seeded.runId, ['CANCELLED', 'FAILED', 'COMPLETED'])).toBe('CANCELLED');
    expect(await Promise.all(control.aliveAtCancel)).toEqual([false]);
    expect(await groupExists(pgid)).toBe(false);
    expect(recordState(stack.temp, seeded.key)).toBe('UNKNOWN');
    expect(reconciledOutcomes(stack.temp, seeded.runId)).toEqual(['unknown']);
    expect(stack.completions()).toBe(0);
  });

  it('a child that closed fd 3 (sleep 30 & exec 3>&-) is gone before CANCELLED', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const seeded = await seedCancellingRun(stack.temp, BASH, 'sleep 30 & exec 3>&-; wait');
    const pgid = seeded.pgid as number;
    replaceSessionTmpWithSymlink(stack.temp, seeded.sessionId);
    control.watchedGroups = [pgid];
    await launchRuntime(stack.temp, { clock: createFakeClock(RUNTIME_MS) });
    expect(await waitForStatus(stack.temp, seeded.runId, ['CANCELLED', 'FAILED', 'COMPLETED'])).toBe('CANCELLED');
    expect(await Promise.all(control.aliveAtCancel)).toEqual([false]);
    expect(await groupExists(pgid)).toBe(false);
    expect(recordState(stack.temp, seeded.key)).toBe('UNKNOWN');
  });

  it('a started MCP call becomes tool.reconciled{unknown} without connecting MCP', PROCESS_TIMEOUT, async () => {
    const stack = await startStack({}, { mcpServers: { fx: { command: process.execPath, args: [MCP_MODERN_SERVER_PATH] } } });
    const seeded = await seedCancellingRun(stack.temp, { callId: 'call_mcp_1', name: 'mcp__fx__echo', args: { text: 'x' }, kind: 'other' });
    await launchRuntime(stack.temp, { clock: createFakeClock(RUNTIME_MS) });
    expect(await waitForStatus(stack.temp, seeded.runId, ['CANCELLED', 'FAILED', 'COMPLETED'])).toBe('CANCELLED');
    expect(reconciledOutcomes(stack.temp, seeded.runId)).toEqual(['unknown']);
    expect(control.poolsCreated).toBe(0);
    expect(fs.readdirSync(stack.temp.paths.markers.mcp)).toEqual([]);
    expect(eventTypes(stack.temp, seeded.runId)).not.toContain('tool.completed');
  });

  it('an UNKNOWN record whose marker survived is reaped at the next start (safety net)', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const store = await openSeedStore(stack.temp);
    const key = 'c'.repeat(64);
    let pgid: number;
    try {
      store.idempotency.begin(key, { expiresAt: RUNTIME_MS + 86_400_000, meta: { tool: 'Bash' } });
      pgid = spawnHolder(path.join(stack.temp.paths.markers.tools, key), 'exec sleep 30');
      store.idempotency.attachProcess(key, { pgid, startedAt: SEED_MS });
      store.idempotency.markUnknown(key);
    } finally {
      store.close();
    }
    expect(await groupExists(pgid)).toBe(true);
    const launched = await launchRuntime(stack.temp, { clock: createFakeClock(RUNTIME_MS) });
    expect(launched.stdout.lines()).toHaveLength(1);
    expect(await groupExists(pgid)).toBe(false);
    expect(fs.existsSync(path.join(stack.temp.paths.markers.tools, key))).toBe(false);
    expect(recordState(stack.temp, key)).toBe('UNKNOWN');
  });
});
