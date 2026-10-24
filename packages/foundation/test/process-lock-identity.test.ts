import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GARBLED_LOCK_GRACE_MS, GHOST_CONFIRM_MS, ProcessLockHeldError, acquireProcessLock, createLockVerdictMemo, defaultProcessStartProbe, inspectProcessLock } from '@momonga/foundation';
import type { LockTiming, ProcessStartProbe } from '@momonga/foundation';
import { registerCleanup, spawnTracked, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { judgeLock } from '../src/process-lock.ts';
import type { LockObservation, LockVerdict } from '../src/process-lock.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const lockIn = (dir: string, name = 'runtime.lock'): string => path.join(dir, name);

const livePid = (context: CleanupContext): number => spawnTracked(context, '/bin/sleep', ['60'], { stdio: 'ignore' }).pid;

const deadPid = async (context: CleanupContext): Promise<number> => {
  const child = spawnTracked(context, '/usr/bin/true', [], { stdio: 'ignore' });
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  return child.pid;
};

const writeLock = (lockPath: string, content: string, mtimeMs?: number): number => {
  fs.writeFileSync(lockPath, content, { mode: 0o600 });
  if (mtimeMs !== undefined) fs.utimesSync(lockPath, mtimeMs / 1000, mtimeMs / 1000);
  return fs.statSync(lockPath).mtimeMs;
};

const content = (lockPath: string): string => fs.readFileSync(lockPath, 'utf8').trim();

const countingProbe = (answer: (pid: number) => number | undefined): ProcessStartProbe & { calls: number[] } => {
  const calls: number[] = [];
  const probe = async (pid: number): Promise<number | undefined> => {
    calls.push(pid);
    return answer(pid);
  };
  return Object.assign(probe, { calls });
};

const outcomeOf = async (promise: Promise<{ release(): void }>): Promise<'acquired' | ProcessLockHeldError | unknown> =>
  promise.then(
    (lock) => {
      lock.release();
      return 'acquired' as const;
    },
    (error: unknown) => error,
  );

describe('acquireProcessLock with a start-time probe', () => {
  it('ghost: a live pid that started after the lock was written is stale', async (context) => {
    const lockPath = lockIn(withTempDir(context));
    const holder = livePid(context);
    const mtime = writeLock(lockPath, String(holder));
    const lock = await acquireProcessLock(lockPath, undefined, { startTimeOf: async () => mtime + 10_000 });
    expect(content(lockPath)).toBe(String(process.pid));
    lock.release();
  });

  it('held: a live pid that started before the lock was written is held', async (context) => {
    const lockPath = lockIn(withTempDir(context));
    const holder = livePid(context);
    const mtime = writeLock(lockPath, String(holder));
    const failure = await outcomeOf(acquireProcessLock(lockPath, undefined, { startTimeOf: async () => mtime - 60_000 }));
    expect(failure).toBeInstanceOf(ProcessLockHeldError);
    expect((failure as ProcessLockHeldError).holderPid).toBe(holder);
    expect(content(lockPath)).toBe(String(holder));
  });

  it.for([
    [1999, 'held'],
    [2000, 'held'],
    [2001, 'acquired'],
  ] as const)('tolerance boundary: a start %i ms after the lock time is %s', async ([offset, expected], context) => {
    const lockPath = lockIn(withTempDir(context));
    const holder = livePid(context);
    const mtime = writeLock(lockPath, String(holder));
    const outcome = await outcomeOf(acquireProcessLock(lockPath, undefined, { startTimeOf: async () => mtime + offset }));
    if (expected === 'acquired') {
      expect(outcome).toBe('acquired');
    } else {
      expect(outcome).toBeInstanceOf(ProcessLockHeldError);
      expect(content(lockPath)).toBe(String(holder));
    }
  });

  it('unknown start time fails safe', async (context) => {
    const lockPath = lockIn(withTempDir(context));
    const holder = livePid(context);
    writeLock(lockPath, String(holder));
    const outcome = await outcomeOf(acquireProcessLock(lockPath, undefined, { startTimeOf: async () => undefined }));
    expect(outcome).toBeInstanceOf(ProcessLockHeldError);
    expect(content(lockPath)).toBe(String(holder));
  });

  it('ghost needs a confirming second probe', async (context) => {
    const lockPath = lockIn(withTempDir(context));
    const holder = livePid(context);
    const mtime = writeLock(lockPath, String(holder));
    const answers = [mtime + 10_000, mtime - 60_000];
    const disagreeing = countingProbe(() => answers.shift());
    const outcome = await outcomeOf(acquireProcessLock(lockPath, undefined, { startTimeOf: disagreeing }));
    expect(outcome).toBeInstanceOf(ProcessLockHeldError);
    expect(disagreeing.calls).toEqual([holder, holder]);
    expect(content(lockPath)).toBe(String(holder));

    const agreeing = countingProbe(() => mtime + 10_000);
    expect(await outcomeOf(acquireProcessLock(lockPath, undefined, { startTimeOf: agreeing }))).toBe('acquired');
    expect(agreeing.calls).toEqual([holder, holder]);
  });

  it('ghost confirmation re-reads the lock: a lock replaced between the probes is not removed', async (context) => {
    const lockPath = lockIn(withTempDir(context));
    const ghost = livePid(context);
    const successor = livePid(context);
    const ghostMtime = writeLock(lockPath, String(ghost), Date.now() - 600_000);
    let successorMtime = 0;
    const probe = countingProbe((pid) => {
      if (pid === ghost) {
        if (successorMtime === 0) successorMtime = writeLock(lockPath, String(successor), ghostMtime + 300_000);
        return ghostMtime + 10_000;
      }
      return successorMtime - 60_000;
    });
    const outcome = await outcomeOf(acquireProcessLock(lockPath, undefined, { startTimeOf: probe }));
    expect(outcome).toBeInstanceOf(ProcessLockHeldError);
    expect(probe.calls.filter((pid) => pid === ghost)).toHaveLength(2);
    expect(content(lockPath)).toBe(String(successor));
  });

  it('probe is not called on the uncontended path', async (context) => {
    const lockPath = lockIn(withTempDir(context));
    const probe = countingProbe(() => 0);
    expect(await outcomeOf(acquireProcessLock(lockPath, undefined, { startTimeOf: probe }))).toBe('acquired');
    expect(probe.calls).toEqual([]);
  });

  it('probe is not called for a dead pid', async (context) => {
    const lockPath = lockIn(withTempDir(context));
    writeLock(lockPath, String(await deadPid(context)));
    const probe = countingProbe(() => 0);
    expect(await outcomeOf(acquireProcessLock(lockPath, undefined, { startTimeOf: probe }))).toBe('acquired');
    expect(probe.calls).toEqual([]);
  });

  it('takeover re-checks the lock: a lock re-created after the ghost verdict survives', async (context) => {
    const lockPath = lockIn(withTempDir(context));
    const ghost = livePid(context);
    const successor = livePid(context);
    const ghostMtime = writeLock(lockPath, String(ghost), Date.now() - 600_000);
    let ghostCalls = 0;
    let successorMtime = 0;
    const probe = countingProbe((pid) => {
      if (pid === ghost) {
        ghostCalls += 1;
        if (ghostCalls === 2) successorMtime = writeLock(lockPath, String(successor), ghostMtime + 300_000);
        return ghostMtime + 10_000;
      }
      return successorMtime - 60_000;
    });
    const outcome = await outcomeOf(acquireProcessLock(lockPath, undefined, { startTimeOf: probe }));
    expect(outcome).toBeInstanceOf(ProcessLockHeldError);
    expect((outcome as ProcessLockHeldError).holderPid).toBe(successor);
    expect(content(lockPath)).toBe(String(successor));
  });

  it('lock observation is atomic: a replacement during the probe is judged as one coherent pair', async (context) => {
    const lockPath = lockIn(withTempDir(context));
    const first = livePid(context);
    const replacement = livePid(context);
    const firstMtime = writeLock(lockPath, String(first), Date.now() - 600_000);
    const replacementMtime = firstMtime + 20_000;
    let replaced = false;
    const probe = countingProbe((pid) => {
      if (pid === first) {
        if (!replaced) {
          replaced = true;
          writeLock(lockPath, String(replacement), replacementMtime);
        }
        return firstMtime + 10_000;
      }
      return firstMtime + 15_000;
    });
    const outcome = await outcomeOf(acquireProcessLock(lockPath, async (pid) => `held by ${pid}`, { startTimeOf: probe }));
    expect(outcome).toBeInstanceOf(ProcessLockHeldError);
    const holder = (outcome as ProcessLockHeldError).holderPid;
    expect([first, replacement]).toContain(holder);
    expect((outcome as Error).message).toBe(`held by ${holder}`);
    expect(content(lockPath)).toBe(String(replacement));
  });
});

describe('defaultProcessStartProbe', () => {
  it.runIf(process.platform === 'darwin')('real probe: own pid', async () => {
    const before = Date.now();
    const start = await defaultProcessStartProbe(process.pid);
    expect(start).toBeTypeOf('number');
    expect(start as number).toBeGreaterThanOrEqual(before - process.uptime() * 1000 - 2000);
    expect(start as number).toBeLessThanOrEqual(Date.now());
  });

  it.runIf(process.platform === 'darwin')('real probe: fresh child', async (context) => {
    const spawnedAt = Date.now();
    const pid = livePid(context);
    const start = await defaultProcessStartProbe(pid);
    expect(start).toBeTypeOf('number');
    expect(Math.abs((start as number) - spawnedAt)).toBeLessThanOrEqual(2000);
  });

  it.runIf(process.platform === 'darwin')("real probe ignores the caller's TZ", async (context) => {
    const child = spawnTracked(context, process.execPath, [path.join(FIXTURES, 'probe-fresh-child.ts')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TZ: 'Asia/Tokyo' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const firstLine = await new Promise<string>((resolve) => {
      const check = (): void => {
        const newline = stdout.indexOf('\n');
        if (newline === -1) return;
        child.stdout?.off('data', onChunk);
        resolve(stdout.slice(0, newline));
      };
      const onChunk = (): void => check();
      child.stdout?.on('data', onChunk);
      check();
    });
    const sleeperPid = (JSON.parse(firstLine) as { sleeper: number }).sleeper;
    registerCleanup(context, () => {
      try {
        process.kill(sleeperPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', (exitCode) => resolve(exitCode)));
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.slice(firstLine.length + 1)) as { spawnedAt: number; start: number | null };
    expect(result.start).toBeTypeOf('number');
    expect(Math.abs((result.start as number) - result.spawnedAt)).toBeLessThanOrEqual(2000);
    try {
      process.kill(sleeperPid, 0);
      throw new Error(`sleeper ${sleeperPid} is still alive`);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
  });

  it('real probe: dead or bogus pid', async (context) => {
    expect(await defaultProcessStartProbe(await deadPid(context))).toBeUndefined();
    expect(await defaultProcessStartProbe(99_999_999)).toBeUndefined();
  });

  it.runIf(process.platform === 'darwin')('ghost lock with real ps', async (context) => {
    const lockPath = lockIn(withTempDir(context));
    const holder = livePid(context);
    writeLock(lockPath, String(holder), Date.now() - 3_600_000);
    const lock = await acquireProcessLock(lockPath);
    expect(content(lockPath)).toBe(String(process.pid));
    lock.release();
  });
});

const NOW = 1_800_000_000_000;

type JudgeCase = {
  name: string;
  observation: LockObservation;
  alive: boolean;
  probes: Array<number | undefined>;
  expected: LockVerdict;
  probeCalls: number;
};

const judgeCases: JudgeCase[] = [
  { name: 'no lock file', observation: { kind: 'missing' }, alive: false, probes: [], expected: 'missing', probeCalls: 0 },
  { name: 'dead pid', observation: { kind: 'pid', pid: 41, modifiedAtMs: NOW - 5000 }, alive: false, probes: [], expected: 'stale', probeCalls: 0 },
  { name: 'unknown start', observation: { kind: 'pid', pid: 42, modifiedAtMs: NOW - 5000 }, alive: true, probes: [undefined], expected: 'held', probeCalls: 1 },
  { name: 'old holder', observation: { kind: 'pid', pid: 43, modifiedAtMs: NOW - 5000 }, alive: true, probes: [NOW - 65_000], expected: 'held', probeCalls: 1 },
  { name: 'start at +2000', observation: { kind: 'pid', pid: 44, modifiedAtMs: NOW - 5000 }, alive: true, probes: [NOW - 3000], expected: 'held', probeCalls: 1 },
  { name: 'ghost confirmed', observation: { kind: 'pid', pid: 45, modifiedAtMs: NOW - 5000 }, alive: true, probes: [NOW - 2999, NOW - 2999], expected: 'stale', probeCalls: 2 },
  { name: 'ghost not confirmed', observation: { kind: 'pid', pid: 46, modifiedAtMs: NOW - 5000 }, alive: true, probes: [NOW + 5000, NOW - 60_000], expected: 'held', probeCalls: 2 },
  { name: 'garbled old', observation: { kind: 'garbled', modifiedAtMs: NOW - 2001 }, alive: false, probes: [], expected: 'stale', probeCalls: 0 },
  { name: 'garbled at the grace', observation: { kind: 'garbled', modifiedAtMs: NOW - 2000 }, alive: false, probes: [], expected: 'unreadable', probeCalls: 0 },
  { name: 'garbled young', observation: { kind: 'garbled', modifiedAtMs: NOW - 10 }, alive: false, probes: [], expected: 'unreadable', probeCalls: 0 },
];

const judgeWith = (testCase: JudgeCase, memo?: ReturnType<typeof createLockVerdictMemo>) => {
  const answers = [...testCase.probes];
  const probe = countingProbe(() => answers.shift());
  const sleeps: number[] = [];
  const verdict = judgeLock(testCase.observation, {
    isAlive: () => testCase.alive,
    startTimeOf: probe,
    reobserve: async () => testCase.observation,
    now: () => NOW,
    sleep: async (ms) => void sleeps.push(ms),
    ...(memo === undefined ? {} : { memo }),
  });
  return { verdict, probe, sleeps };
};

describe('judgeLock', () => {
  it.each(judgeCases)('judgeLock table: $name gives $expected', async (testCase) => {
    const { verdict, probe } = judgeWith(testCase);
    expect(await verdict).toBe(testCase.expected);
    expect(probe.calls).toHaveLength(testCase.probeCalls);
  });

  it('the confirmation probe runs after a 250 ms pause and a re-read of the lock', async () => {
    const observation: LockObservation = { kind: 'pid', pid: 47, modifiedAtMs: NOW - 5000 };
    const events: string[] = [];
    const verdict = await judgeLock(observation, {
      isAlive: () => true,
      startTimeOf: async () => {
        events.push('probe');
        return NOW;
      },
      reobserve: async () => {
        events.push('reobserve');
        return observation;
      },
      now: () => NOW,
      sleep: async (ms) => void events.push(`sleep ${ms}`),
    });
    expect(verdict).toBe('stale');
    expect(events).toEqual(['probe', 'sleep 250', 'reobserve', 'probe']);
  });

  it('a lock replaced before the confirmation is not judged stale', async () => {
    const verdict = await judgeLock(
      { kind: 'pid', pid: 48, modifiedAtMs: NOW - 5000 },
      {
        isAlive: () => true,
        startTimeOf: async () => NOW,
        reobserve: async () => ({ kind: 'pid', pid: 48, modifiedAtMs: NOW - 1 }),
        now: () => NOW,
        sleep: async () => undefined,
      },
    );
    expect(verdict).not.toBe('stale');
  });

  it('memo: a held verdict skips the probe for the same pid and lock time and is cleared otherwise', async () => {
    const memo = createLockVerdictMemo();
    const observation: LockObservation = { kind: 'pid', pid: 49, modifiedAtMs: NOW - 5000 };
    const probe = countingProbe(() => NOW - 60_000);
    const dependencies = { isAlive: () => true, startTimeOf: probe, reobserve: async () => observation, now: () => NOW, sleep: async () => undefined, memo };
    expect(await judgeLock(observation, dependencies)).toBe('held');
    expect(await judgeLock(observation, dependencies)).toBe('held');
    expect(probe.calls).toHaveLength(1);
    const renewed: LockObservation = { kind: 'pid', pid: 49, modifiedAtMs: NOW - 4000 };
    expect(await judgeLock(renewed, { ...dependencies, reobserve: async () => renewed })).toBe('held');
    expect(probe.calls).toHaveLength(2);
    expect(await judgeLock(renewed, { ...dependencies, isAlive: () => false })).toBe('stale');
    expect(await judgeLock(renewed, { ...dependencies, reobserve: async () => renewed })).toBe('held');
    expect(probe.calls).toHaveLength(3);
  });
});

type LockFixture = {
  name: string;
  prepare(context: CleanupContext, dir: string): Promise<{ lockPath: string; probe: ProcessStartProbe }>;
  acquire: 'acquired' | 'held' | 'paused';
  inspect: 'free' | 'held' | 'unreadable';
};

const liveLock = (offsetFromMtime: number | undefined): LockFixture['prepare'] => async (context, dir) => {
  const lockPath = lockIn(dir);
  const mtime = writeLock(lockPath, String(livePid(context)), Date.now() - 600_000);
  return { lockPath, probe: async () => (offsetFromMtime === undefined ? undefined : mtime + offsetFromMtime) };
};

const lockFixtures: LockFixture[] = [
  {
    name: 'dead pid',
    prepare: async (context, dir) => {
      const lockPath = lockIn(dir);
      writeLock(lockPath, String(await deadPid(context)));
      return { lockPath, probe: async () => 0 };
    },
    acquire: 'acquired',
    inspect: 'free',
  },
  { name: 'live old holder', prepare: liveLock(-60_000), acquire: 'held', inspect: 'held' },
  { name: 'live young holder that started after the lock within the tolerance', prepare: liveLock(1000), acquire: 'held', inspect: 'held' },
  { name: 'ghost', prepare: liveLock(10_000), acquire: 'acquired', inspect: 'free' },
  { name: 'tolerance +1999', prepare: liveLock(1999), acquire: 'held', inspect: 'held' },
  { name: 'tolerance +2000', prepare: liveLock(2000), acquire: 'held', inspect: 'held' },
  { name: 'tolerance +2001', prepare: liveLock(2001), acquire: 'acquired', inspect: 'free' },
  { name: 'undefined probe', prepare: liveLock(undefined), acquire: 'held', inspect: 'held' },
  {
    name: 'garbled young',
    prepare: async (context, dir) => {
      const lockPath = lockIn(dir);
      writeLock(lockPath, 'not-a-pid');
      return { lockPath, probe: async () => 0 };
    },
    acquire: 'paused',
    inspect: 'unreadable',
  },
  {
    name: 'garbled old',
    prepare: async (context, dir) => {
      const lockPath = lockIn(dir);
      writeLock(lockPath, 'not-a-pid', Date.now() - 60_000);
      return { lockPath, probe: async () => 0 };
    },
    acquire: 'acquired',
    inspect: 'free',
  },
  {
    name: 'missing',
    prepare: async (context, dir) => ({ lockPath: lockIn(dir), probe: async () => 0 }),
    acquire: 'acquired',
    inspect: 'free',
  },
];

const snapshotOf = (dir: string): Record<string, string> =>
  Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));

describe('inspectProcessLock', () => {
  it('inspectProcessLock reports free, held, and ghost as free', async (context) => {
    const dir = withTempDir(context);
    const holder = livePid(context);
    const ghost = livePid(context);
    const heldLock = lockIn(dir, 'held.lock');
    const ghostLock = lockIn(dir, 'ghost.lock');
    const heldMtime = writeLock(heldLock, String(holder));
    const ghostMtime = writeLock(ghostLock, String(ghost), Date.now() - 600_000);
    const before = snapshotOf(dir);
    expect(await inspectProcessLock(lockIn(dir, 'missing.lock'), { startTimeOf: async () => 0 })).toEqual({ state: 'free' });
    expect(await inspectProcessLock(heldLock, { startTimeOf: async () => heldMtime - 60_000 })).toEqual({ state: 'held', pid: holder });
    expect(await inspectProcessLock(ghostLock, { startTimeOf: async () => ghostMtime + 10_000 })).toEqual({ state: 'free' });
    expect(snapshotOf(dir)).toEqual(before);
  });

  it('inspectProcessLock reports unreadable only for a young garbled lock', async (context) => {
    const dir = withTempDir(context);
    const lockPath = lockIn(dir);
    writeLock(lockPath, 'garbage');
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'unreadable' });
    writeLock(lockPath, 'garbage', Date.now() - 2500);
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
    expect(content(lockPath)).toBe('garbage');
    fs.rmSync(lockPath);
    expect(await inspectProcessLock(lockPath)).toEqual({ state: 'free' });
  });

  it('parity: acquire and inspect classify every fixture alike', { timeout: 20_000 }, async (context) => {
    for (const fixture of lockFixtures) {
      const { lockPath, probe } = await fixture.prepare(context, withTempDir(context));
      const inspected = await inspectProcessLock(lockPath, { startTimeOf: probe });
      expect(inspected.state, fixture.name).toBe(fixture.inspect);
      const startedAt = Date.now();
      const outcome = await outcomeOf(acquireProcessLock(lockPath, undefined, { startTimeOf: probe }));
      if (fixture.acquire === 'held') {
        expect(outcome, fixture.name).toBeInstanceOf(ProcessLockHeldError);
      } else {
        expect(outcome, fixture.name).toBe('acquired');
      }
      if (fixture.acquire === 'paused') expect(Date.now() - startedAt, fixture.name).toBeGreaterThanOrEqual(1500);
    }
  });

  it('memo: 20 inspections of a live holder call the probe once', async (context) => {
    const lockPath = lockIn(withTempDir(context));
    const holder = spawnTracked(context, '/bin/sleep', ['60'], { stdio: 'ignore' });
    let mtime = writeLock(lockPath, String(holder.pid), Date.now() - 600_000);
    const probe = countingProbe(() => mtime - 60_000);
    const memo = createLockVerdictMemo();
    for (let index = 0; index < 20; index += 1) {
      expect(await inspectProcessLock(lockPath, { startTimeOf: probe, memo })).toEqual({ state: 'held', pid: holder.pid });
    }
    expect(probe.calls).toHaveLength(1);
    mtime = writeLock(lockPath, String(holder.pid), Date.now() - 300_000);
    expect(await inspectProcessLock(lockPath, { startTimeOf: probe, memo })).toEqual({ state: 'held', pid: holder.pid });
    expect(probe.calls).toHaveLength(2);
    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    holder.kill('SIGKILL');
    await exited;
    expect(await inspectProcessLock(lockPath, { startTimeOf: probe, memo })).toEqual({ state: 'free' });
    expect(probe.calls).toHaveLength(2);
  });

  it('memo never changes a verdict', { timeout: 20_000 }, async (context) => {
    const shared = createLockVerdictMemo();
    for (const fixture of lockFixtures) {
      const { lockPath, probe } = await fixture.prepare(context, withTempDir(context));
      const fresh = await inspectProcessLock(lockPath, { startTimeOf: probe, memo: createLockVerdictMemo() });
      const withShared = await inspectProcessLock(lockPath, { startTimeOf: probe, memo: shared });
      const again = await inspectProcessLock(lockPath, { startTimeOf: probe, memo: shared });
      expect(withShared, fixture.name).toEqual(fresh);
      expect(again, fixture.name).toEqual(fresh);
      expect(fresh.state, fixture.name).toBe(fixture.inspect);
    }
  });
});

type ManualLockTiming = { timing: LockTiming; sleeps: number[] };

const manualLockTiming = (startAt: number): ManualLockTiming => {
  let current = startAt;
  const sleeps: number[] = [];
  return {
    sleeps,
    timing: {
      now: () => current,
      sleep: async (ms) => {
        sleeps.push(ms);
        current += ms;
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    },
  };
};

describe('lock time port', () => {
  it('timing port drives the ghost confirmation pause in acquire and inspect', async (context) => {
    const dir = withTempDir(context);
    const holder = livePid(context);
    const acquireLockPath = lockIn(dir, 'acquire.lock');
    const inspectLockPath = lockIn(dir, 'inspect.lock');
    const acquireMtime = writeLock(acquireLockPath, String(holder));
    const inspectMtime = writeLock(inspectLockPath, String(holder));
    const acquireTiming = manualLockTiming(acquireMtime);
    const lock = await acquireProcessLock(acquireLockPath, undefined, { startTimeOf: async () => acquireMtime + 10_000, timing: acquireTiming.timing });
    expect(acquireTiming.sleeps).toEqual([GHOST_CONFIRM_MS]);
    expect(content(acquireLockPath)).toBe(String(process.pid));
    lock.release();
    const inspectTiming = manualLockTiming(inspectMtime);
    expect(await inspectProcessLock(inspectLockPath, { startTimeOf: async () => inspectMtime + 10_000, timing: inspectTiming.timing })).toEqual({ state: 'free' });
    expect(inspectTiming.sleeps).toEqual([GHOST_CONFIRM_MS]);
  });

  it('timing port decides the garbled-lock age for inspect, whatever the real clock says', async (context) => {
    const dir = withTempDir(context);
    const lockPath = lockIn(dir);
    const youngMtime = writeLock(lockPath, 'garbage');
    expect(await inspectProcessLock(lockPath, { timing: manualLockTiming(youngMtime + GARBLED_LOCK_GRACE_MS + 1).timing })).toEqual({ state: 'free' });
    expect(await inspectProcessLock(lockPath, { timing: manualLockTiming(youngMtime + GARBLED_LOCK_GRACE_MS).timing })).toEqual({ state: 'unreadable' });
    const oldMtime = writeLock(lockPath, 'garbage', Date.now() - 3_600_000);
    expect(await inspectProcessLock(lockPath, { timing: manualLockTiming(oldMtime + GARBLED_LOCK_GRACE_MS).timing })).toEqual({ state: 'unreadable' });
    expect(content(lockPath)).toBe('garbage');
  });

  it('timing port decides the garbled-lock age for acquire, whatever the real clock says', async (context) => {
    const dir = withTempDir(context);
    const staleLockPath = lockIn(dir, 'stale.lock');
    const staleMtime = writeLock(staleLockPath, 'garbage');
    const staleTiming = manualLockTiming(staleMtime + GARBLED_LOCK_GRACE_MS + 1);
    const staleLock = await acquireProcessLock(staleLockPath, undefined, { timing: staleTiming.timing });
    expect(content(staleLockPath)).toBe(String(process.pid));
    expect(staleTiming.sleeps).toEqual([]);
    staleLock.release();
    const youngLockPath = lockIn(dir, 'young.lock');
    const youngMtime = writeLock(youngLockPath, 'garbage', Date.now() - 3_600_000);
    const youngTiming = manualLockTiming(youngMtime + GARBLED_LOCK_GRACE_MS);
    const youngLock = await acquireProcessLock(youngLockPath, undefined, { timing: youngTiming.timing });
    expect(content(youngLockPath)).toBe(String(process.pid));
    expect(youngTiming.sleeps.length).toBeGreaterThan(0);
    expect(youngTiming.sleeps.every((ms) => ms > 0 && ms < GARBLED_LOCK_GRACE_MS)).toBe(true);
    youngLock.release();
  });
});
