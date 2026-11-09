import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpPool, createStdioTransport } from '@momonga/mcp';
import type { StdioTransport, StdioTransportOptions } from '@momonga/mcp';
import { groupAlive, hostProcessGroupPort, terminateGroup } from '@momonga/foundation';
import type { DeadlineTiming, ProcessGroupPort } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, afterMicrotasks, createFakeClock, createFakeTimers, killGroupsForCleanup, waitFor } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import { BASE_ENV, entry, makeRecordFile, modernConfig } from './mcp-harness.ts';

const STUBBORN_SERVER = path.join(import.meta.dirname, 'fixtures', 'stubborn-stdio-server.ts');
const GROUP_POLL_INTERVAL_MS = 10;
const REAP_POLL_INTERVAL_MS = 25;
const poolCloseBoundMs = (graceMs: number): number => 8 * graceMs + 2 * GROUP_POLL_INTERVAL_MS + 4 * REAP_POLL_INTERVAL_MS;
const DRIVE_MAX_TURNS = 200_000;

const dirs: string[] = [];
const groups: number[] = [];

afterEach(async () => {
  await killGroupsForCleanup(groups.splice(0));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const projectDir = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mcp-grace-')));
  dirs.push(dir);
  return dir;
};

type RecordingTiming = DeadlineTiming & { delays: number[] };

const recordingTiming = (timers: Pick<FakeTimers, 'now' | 'setTimeout' | 'clearTimeout'>): RecordingTiming => {
  const delays: number[] = [];
  return {
    delays,
    now: () => timers.now(),
    setTimeout: ((callback: () => void, ms: number) => {
      delays.push(ms);
      return timers.setTimeout(callback, ms);
    }) as DeadlineTiming['setTimeout'],
    clearTimeout: ((handle: unknown) => timers.clearTimeout(handle)) as DeadlineTiming['clearTimeout'],
  };
};

const recordingTerminate = (signals: NodeJS.Signals[]): NonNullable<StdioTransportOptions['terminate']> => {
  const host = hostProcessGroupPort();
  const port: ProcessGroupPort = {
    signal: async (pgid, signal, options) => {
      signals.push(signal);
      await host.signal(pgid, signal, options);
    },
    alive: (pgid, options) => host.alive(pgid, options),
  };
  return (pgid, options) => terminateGroup(pgid, { ...options, port });
};

type Stubborn = { transport: StdioTransport; timers: FakeTimers; timing: RecordingTiming; signals: NodeJS.Signals[]; pgid: number };

const startStubborn = async (mode: 'ignore-stdin' | 'ignore-term', creationGraceMs: number): Promise<Stubborn> => {
  const timers = createFakeTimers(createFakeClock(1_000_000));
  const timing = recordingTiming(timers);
  const signals: NodeJS.Signals[] = [];
  const transport = createStdioTransport({
    name: 'stubborn',
    config: { command: process.execPath, args: [STUBBORN_SERVER, mode] },
    projectDir: projectDir(),
    baseEnv: { PATH: '/usr/bin:/bin' },
    closeGraceMs: creationGraceMs,
    timing,
    terminate: recordingTerminate(signals),
  });
  transport.onerror = () => undefined;
  await transport.start();
  const pgid = transport.pgid;
  if (pgid === undefined) throw new Error('the stubborn server has no process group');
  groups.push(pgid);
  await waitFor(() => transport.diagnostics().stderrTail.includes('armed'), { description: 'the stubborn server to install its handlers' });
  return { transport, timers, timing, signals, pgid };
};

const quiescent = (server: Stubborn, mode: 'ignore-stdin' | 'ignore-term'): boolean => {
  if (server.transport.diagnostics().exit !== null) return true;
  const last = server.signals.at(-1);
  if (last === undefined) return true;
  return mode === 'ignore-term' && last === 'SIGTERM' && server.transport.diagnostics().stderrTail.includes('term');
};

const closeWithinBound = async (server: Stubborn, mode: 'ignore-stdin' | 'ignore-term', close: () => Promise<void>, graceMs: number): Promise<number> => {
  const startedAt = server.timers.now();
  const horizonAt = startedAt + poolCloseBoundMs(graceMs);
  let outcome: { kind: 'resolved' } | { kind: 'rejected'; error: unknown } | undefined;
  close().then(
    () => (outcome = { kind: 'resolved' }),
    (error: unknown) => (outcome = { kind: 'rejected', error }),
  );
  await waitFor(() => outcome !== undefined || server.timing.delays.includes(graceMs), {
    description: `the transport to arm its wait for the exit (grace ${graceMs}) on the injected timing; armed so far: ${JSON.stringify(server.timing.delays)}`,
  });
  for (let turn = 0; turn < DRIVE_MAX_TURNS && outcome === undefined; turn += 1) {
    await afterMicrotasks();
    if (outcome !== undefined || !quiescent(server, mode)) continue;
    const next = server.timers.nextDueAt();
    if (next !== undefined && next <= horizonAt) server.timers.advance(Math.max(0, next - server.timers.now()));
  }
  if (outcome === undefined) throw new Error(`the close did not end within ${poolCloseBoundMs(graceMs)} fake ms; delays armed on the injected timing: ${JSON.stringify(server.timing.delays)}`);
  if (outcome.kind === 'rejected') throw outcome.error;
  return server.timers.now() - startedAt;
};

describe('the real stdio transport closes within mcpPoolCloseBoundMs of the grace, on its injected timing (R4b)', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it.for([
    ['ignore-stdin', 0],
    ['ignore-stdin', 1000],
    ['ignore-stdin', 30_000],
    ['ignore-term', 0],
    ['ignore-term', 1000],
    ['ignore-term', 30_000],
  ] as const)('a server that ignores %s, at grace %d', async ([mode, graceMs]) => {
    const server = await startStubborn(mode, graceMs);
    const elapsed = await closeWithinBound(server, mode, () => server.transport.close(), graceMs);
    expect(server.timing.delays.filter((delay) => delay === graceMs).length).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThanOrEqual(poolCloseBoundMs(graceMs));
    expect(await groupAlive(server.pgid)).toBe(false);
    expect(server.signals[0]).toBe('SIGTERM');
    if (mode === 'ignore-term' && graceMs > 0) expect(server.signals).toContain('SIGKILL');
  });
});

describe('the grace of a close is an argument of that close', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('close(250) waits 250, not the grace the transport was created with', async () => {
    const server = await startStubborn('ignore-stdin', 30_000);
    const elapsed = await closeWithinBound(server, 'ignore-stdin', () => (server.transport.close as (graceMs?: number) => Promise<void>)(250), 250);
    expect(server.timing.delays).toContain(250);
    expect(server.timing.delays).not.toContain(30_000);
    expect(elapsed).toBeLessThanOrEqual(poolCloseBoundMs(250));
  });

  it('at grace 0 the group is gone when the close returns (R7)', async () => {
    const server = await startStubborn('ignore-term', 30_000);
    await closeWithinBound(server, 'ignore-term', () => (server.transport.close as (graceMs?: number) => Promise<void>)(0), 0);
    expect(server.timing.delays).toContain(0);
    expect(await groupAlive(server.pgid)).toBe(false);
  });

  it('a pool close passes its grace through each connection to its transport, on the timing the pool was given', async () => {
    const timers = createFakeTimers(createFakeClock(1_000_000));
    const real = { now: () => timers.now(), setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
    const timing = recordingTiming(real);
    const pool = createMcpPool({
      servers: [entry('modern', modernConfig(makeRecordFile()))],
      projectDir: projectDir(),
      baseEnv: BASE_ENV,
      clock: { now: () => timers.now() } as never,
      timers: timing,
      random: () => 0,
      closeGraceMs: 29_999,
    });
    await pool.sources[0]?.list({});
    timing.delays.splice(0);
    await (pool.close as (graceMs?: number) => Promise<void>)(250);
    expect(timing.delays).toContain(250);
    expect(timing.delays).not.toContain(29_999);
  });
});
