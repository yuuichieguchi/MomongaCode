import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedConnection } from '@momonga/mcp';
import { KILL_CONFIRM_MS, isProcessAlive, nodeFileSystem } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';
import { afterMicrotasks, createFakeClock, createFakeTimers, createTempDir, killPidsForCleanup, REAL_PROCESS_TEST_TIMEOUT_MS, TEST_STDIO_LAUNCH, waitFor } from '@momonga/testkit';

const STUBBORN_SERVER = path.join(import.meta.dirname, 'fixtures', 'stubborn-stdio-server.ts');
const poolCloseBoundMs = (graceMs: number): number => 6 * graceMs + 3 * 25 + 2 * KILL_CONFIRM_MS;
const DRIVE_MAX_TURNS = 200_000;

const dirs: string[] = [];
const pids: number[] = [];

afterEach(() => {
  killPidsForCleanup(pids.splice(0));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
  const dir = createTempDir();
  dirs.push(dir);
  return dir;
};

const spawnedPids = (pidFile: string): number[] =>
  fs.existsSync(pidFile)
    ? fs
        .readFileSync(pidFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map(Number)
    : [];

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

describe('a connection closed during its handshake (R5, R6)', () => {
  it.for([0, 1000])('at grace %d, the abort settles the handshake at once, one transport is closed, and the close ends within mcpPoolCloseBoundMs', async (graceMs) => {
    const dir = tempDir();
    const pidFile = path.join(dir, 'pids');
    const clock = createFakeClock(1_000_000);
    const timers = createFakeTimers(clock);
    const delays: number[] = [];
    const recording = {
      setTimeout: ((callback: () => void, ms: number) => {
        delays.push(ms);
        return timers.setTimeout(callback, ms);
      }) as Timing['setTimeout'],
      clearTimeout: ((handle: unknown) => timers.clearTimeout(handle)) as Timing['clearTimeout'],
    };
    const connection = createManagedConnection({ launch: TEST_STDIO_LAUNCH, files: nodeFileSystem,
      clientVersion: '0.0.0-test',
      name: 'stubborn',
      config: { command: process.execPath, args: [STUBBORN_SERVER, 'ignore-stdin', `--pid-file=${pidFile}`] },
      scope: 'user',
      projectDir: dir,
      baseEnv: { PATH: '/usr/bin:/bin' },
      clock,
      timers: recording,
      closeGraceMs: 29_999,
    });
    const listing = connection.listTools().catch((error: unknown) => error);
    await waitFor(() => spawnedPids(pidFile).length === 1, { description: 'the server of the handshake to start' });
    const [pid] = spawnedPids(pidFile) as [number];
    pids.push(pid);
    const startedAt = timers.now();
    let outcome: { kind: 'resolved' } | { kind: 'rejected'; error: unknown } | undefined;
    (connection.close as (graceMs?: number) => Promise<void>)(graceMs).then(
      () => (outcome = { kind: 'resolved' }),
      (error: unknown) => (outcome = { kind: 'rejected', error }),
    );
    await waitFor(() => outcome !== undefined || delays.includes(graceMs), {
      description: `the transport to arm its wait for the exit (grace ${graceMs}) on the timing of its connection; armed so far: ${JSON.stringify(delays)}`,
    });
    const horizonAt = startedAt + poolCloseBoundMs(graceMs);
    for (let turn = 0; turn < DRIVE_MAX_TURNS && outcome === undefined; turn += 1) {
      await afterMicrotasks();
      if (outcome !== undefined) break;
      if (timers.now() - startedAt >= Math.max(graceMs, 1) && isProcessAlive(pid)) continue;
      const next = timers.nextDueAt();
      if (next !== undefined && next <= horizonAt) timers.advance(Math.max(0, next - timers.now()));
    }
    expect(outcome).toEqual({ kind: 'resolved' });
    expect(timers.now() - startedAt).toBeLessThanOrEqual(poolCloseBoundMs(graceMs));
    expect(await listing).toBeInstanceOf(Error);
    expect(spawnedPids(pidFile)).toEqual([pid]);
    expect(isProcessAlive(pid)).toBe(false);
    expect(delays).not.toContain(29_999);
  });
});
