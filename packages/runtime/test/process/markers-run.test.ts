import { spawn } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimRetry, ensureMomongaDirs, groupAlive, momongaPaths, readAttemptRecord, recordMarkerGroup, FIRST_GENERATION } from '@momonga/foundation';
import { openRuntimeStore } from '@momonga/store';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, spawnTracked, withTempDir, firstGeneration } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { START_MS, createRun, createSession, trackGroup, writeUserSettings } from './helpers.ts';
import { RUNTIME_VERSION, captureStream, failureOf, hookLogger, isLockFree, launchRuntime, modelSettings, prepareStack, readDb, startRuntimeProcess, stepsLogged, prepareGeneration, scopedPaths } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const control = vi.hoisted(() => ({ lookupError: undefined as Error | undefined }));

vi.mock('@momonga/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/store')>();
  return {
    ...original,
    openRuntimeStore: (options: Parameters<typeof original.openRuntimeStore>[0]) => {
      const store = original.openRuntimeStore(options);
      const idempotency = new Proxy(store.idempotency, {
        get: (target, key, receiver) => {
          if (key === 'get') {
            return (idempotencyKey: string) => {
              if (control.lookupError !== undefined) throw control.lookupError;
              return target.get(idempotencyKey);
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
      return new Proxy(store, { get: (target, key, receiver) => (key === 'idempotency' ? idempotency : Reflect.get(target, key, receiver)) });
    },
  };
});

const SEED_MS = START_MS;

beforeEach(() => {
  control.lookupError = undefined;
});

const groupExists = (pgid: number): Promise<boolean> => groupAlive(pgid);

const spawnHolder = (marker: string, content?: (pid: number) => string): number => {
  const fd = fs.openSync(marker, 'w', 0o600);
  let pid: number | undefined;
  try {
    pid = spawn('/bin/sh', ['-c', 'exec sleep 30'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] }).pid;
    if (pid !== undefined && content !== undefined) fs.writeSync(fd, content(pid));
  } finally {
    fs.closeSync(fd);
  }
  if (pid === undefined) throw new Error('the marker holder did not spawn');
  trackGroup(pid);
  return pid;
};

const seedStore = async (temp: RunHome, seed: (store: ReturnType<typeof openRuntimeStore>) => void): Promise<void> => {
  await prepareGeneration(temp);
  const store = openRuntimeStore({ path: temp.paths.databases.runtime, home: temp.home, clock: createFakeClock(SEED_MS), leaseMs: 30_000, maxAttempts: 5, maxTotalAttempts: 20 });
  try {
    seed(store);
  } finally {
    store.close();
  }
};

const keyOf = (letter: string): string => letter.repeat(64);

describe('startup marker reaping through startRuntimeProcess (real processes, system timers)', () => {
  it('reaps MCP markers left by a killed instance at start', async () => {
    const stack = await prepareStack();
    await prepareGeneration(stack.temp);
    const marker = path.join(scopedPaths(stack.temp).markers.mcp, 'fx-left-behind');
    const pgid = spawnHolder(marker);
    await recordMarkerGroup(marker, pgid);
    expect(await groupExists(pgid)).toBe(true);
    const launched = await launchRuntime(stack.temp);
    expect(stepsLogged(launched.logger)).toContain('mcp-markers');
    expect(await groupExists(pgid)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('the start reap of MCP markers spends the startup retry of a marker once: a marker whose startup retry is spent is left for the other occasions', async () => {
    const stack = await prepareStack();
    await prepareGeneration(stack.temp);
    const marker = path.join(scopedPaths(stack.temp).markers.mcp, 'fx-startup-spent');
    const pgid = spawnHolder(marker);
    await recordMarkerGroup(marker, pgid);
    expect(await claimRetry(marker, 'startup', { signal: new AbortController().signal })).toBe('claimed');
    await launchRuntime(stack.temp);
    expect(await groupExists(pgid)).toBe(true);
    expect((await readAttemptRecord(marker)).spent).toEqual({ guard: false, sweep: false, startup: true, shutdown: false });
  });

  it('tool markers are reaped at start by record state: every held marker is reaped whatever its row says, holder-less markers are deleted', async () => {
    const stack = await prepareStack();
    await prepareGeneration(stack.temp);
    const markers = scopedPaths(stack.temp).markers.tools;
    const holders: Record<string, number> = {};
    await seedStore(stack.temp, (store) => {
      const expiresAt = SEED_MS + 30 * 86_400_000;
      store.idempotency.begin(keyOf('a'), { expiresAt, meta: {} });
      holders['completed'] = spawnHolder(path.join(markers, keyOf('a')));
      store.idempotency.attachProcess(keyOf('a'), { pgid: holders['completed'], startedAt: SEED_MS });
      store.idempotency.complete(keyOf('a'), { ok: true });

      holders['missing'] = spawnHolder(path.join(markers, keyOf('b')));

      store.idempotency.begin(keyOf('c'), { expiresAt, meta: {} });
      holders['unknown'] = spawnHolder(path.join(markers, keyOf('c')));
      store.idempotency.attachProcess(keyOf('c'), { pgid: holders['unknown'], startedAt: SEED_MS });
      store.idempotency.markUnknown(keyOf('c'));

      store.idempotency.begin(keyOf('d'), { expiresAt, meta: {} });
      holders['pending'] = spawnHolder(path.join(markers, keyOf('d')));
      store.idempotency.attachProcess(keyOf('d'), { pgid: holders['pending'], startedAt: SEED_MS });

      store.idempotency.begin(keyOf('e'), { expiresAt, meta: {} });
      fs.writeFileSync(path.join(markers, keyOf('e')), '');
    });
    const launched = await launchRuntime(stack.temp);
    expect(stepsLogged(launched.logger)).toContain('tool-markers');
    expect(await groupExists(holders['completed'] as number)).toBe(false);
    expect(await groupExists(holders['missing'] as number)).toBe(false);
    expect(await groupExists(holders['unknown'] as number)).toBe(false);
    expect(await groupExists(holders['pending'] as number)).toBe(false);
    expect(fs.readdirSync(markers)).toEqual([]);
  });

  it('marks a job a dead runtime left running unknown, and reaps its process group, before the service and the workers start', async () => {
    const stack = await prepareStack();
    await prepareGeneration(stack.temp);
    const jobId = 'bash_dead00000000';
    const idemKey = keyOf('j');
    let pgid: number | undefined;
    await seedStore(stack.temp, (store) => {
      store.idempotency.begin(idemKey, { expiresAt: SEED_MS + 30 * 86_400_000, meta: { job: true } });
      const session = createSession(store, stack.temp.project);
      store.jobs.start({ id: jobId, idemKey, sessionId: session.id, runId: createRun(store, session.id), callId: 'c', command: 'sleep 30' });
      pgid = spawnHolder(path.join(scopedPaths(stack.temp).markers.tools, idemKey));
      store.jobs.attachProcess(jobId, pgid);
    });
    const seen: Record<string, { status: string | undefined; alive: Promise<boolean> }> = {};
    const logger = hookLogger((step, msg) => {
      if (msg !== 'startup.step' || (step !== 'service' && step !== 'workers')) return;
      seen[step] = { status: readDb<{ status: string }>(stack.temp.paths.databases.runtime, 'SELECT status FROM jobs WHERE id = ?', jobId)[0]?.status, alive: groupExists(pgid as number) };
    });

    await launchRuntime(stack.temp, { logger });

    const settled = Object.fromEntries(await Promise.all(Object.entries(seen).map(async ([step, { status, alive }]) => [step, { status, alive: await alive }])));
    expect(settled).toEqual({ service: { status: 'unknown', alive: false }, workers: { status: 'unknown', alive: false } });
  });

  it('a store error during tool-marker reaping fails startup before any process is signalled and unwinds', async () => {
    const stack = await prepareStack();
    await prepareGeneration(stack.temp);
    const holder = spawnHolder(path.join(scopedPaths(stack.temp).markers.tools, keyOf('f')));
    const injected = Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11 });
    control.lookupError = injected;
    const logger = hookLogger(() => undefined);
    const stdout = captureStream();
    const error = await failureOf(startRuntimeProcess({ generation: FIRST_GENERATION, home: stack.temp.home, version: RUNTIME_VERSION, logger, stdout }));
    expect(error).toBe(injected);
    expect(stepsLogged(logger).at(-1)).toBe('tool-markers');
    expect(stepsLogged(logger, 'teardown.step')).toEqual(['store', 'lock']);
    expect(await groupExists(holder)).toBe(true);
    expect(await isLockFree(firstGeneration(stack.temp.paths).locks.runtime)).toBe(true);
    expect(stdout.chunks).toEqual([]);
  });
});

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 5;
const DEAD_LETTER_KEY = 'd'.repeat(64);

const trackedRunHome = (context: CleanupContext): RunHome => {
  const home = withTempDir(context, { asHome: true });
  const root = withTempDir(context);
  writeUserSettings(home, { sandbox: 'none', ...modelSettings(path.join(root, 'up.sock')) });
  return { root, home, paths: momongaPaths(home, process.platform, {}), project: root };
};

const trackedHolder = (context: CleanupContext, marker: string): number => {
  const fd = fs.openSync(marker, 'w', 0o600);
  try {
    return spawnTracked(context, '/bin/sh', ['-c', 'exec sleep 30'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).pid;
  } finally {
    fs.closeSync(fd);
  }
};

type Seeded = { runId: string; pgid: number; lastClaimAt: number };

const seedTakenOverRun = async (context: CleanupContext, temp: RunHome, deadLetterInSeed: boolean): Promise<Seeded> => {
  await prepareGeneration(temp);
  const clock = createFakeClock(SEED_MS);
  const store = openRuntimeStore({ path: temp.paths.databases.runtime, home: temp.home, clock, leaseMs: LEASE_MS, maxAttempts: MAX_ATTEMPTS, maxTotalAttempts: 20 });
  try {
    const session = createSession(store, temp.project);
    const runId = createRun(store, session.id);
    for (let claim = 0; claim < MAX_ATTEMPTS; claim += 1) {
      if (claim > 0) clock.advance(LEASE_MS + 1);
      if (store.claim(`seed-worker-${claim}`)?.runId !== runId) throw new Error(`seed claim ${claim} did not take run ${runId}`);
    }
    const seeded = store.getRun(runId);
    if (seeded?.status !== 'RUNNING' || seeded.failedAttempts !== MAX_ATTEMPTS - 1) {
      throw new Error(`seed did not reach RUNNING with failedAttempts ${MAX_ATTEMPTS - 1}: ${JSON.stringify(seeded)}`);
    }
    const lastClaimAt = clock.now();
    if (deadLetterInSeed) {
      clock.advance(LEASE_MS + 1);
      if (store.claim('seed-final') !== null) throw new Error('the exhausted run was claimed instead of left for the dead-letter sweep');
      await store.deadLetterExhausted((error) => {
        throw error;
      });
      if (store.getRun(runId)?.deadLetter !== true) throw new Error('the seed did not dead-letter the run');
    }
    store.idempotency.begin(DEAD_LETTER_KEY, { expiresAt: clock.now() + 30 * 86_400_000, meta: { tool: 'Bash', runId } });
    const pgid = trackedHolder(context, path.join(scopedPaths(temp).markers.tools, DEAD_LETTER_KEY));
    store.idempotency.attachProcess(DEAD_LETTER_KEY, { pgid, startedAt: clock.now() });
    return { runId, pgid, lastClaimAt };
  } finally {
    store.close();
  }
};

const idempotencyState = (temp: RunHome): string | undefined =>
  readDb<{ state: string }>(temp.paths.databases.runtime, 'SELECT state FROM idempotency WHERE key = ?', DEAD_LETTER_KEY)[0]?.state;

const deadLetterOf = (temp: RunHome, runId: string): { status: string; dead_letter: number } | undefined =>
  readDb<{ status: string; dead_letter: number }>(temp.paths.databases.runtime, 'SELECT status, dead_letter FROM runs WHERE id = ?', runId)[0];

describe('dead-lettered runs: real holders (§8)', () => {
  it('a real holder of a run that is not dead-lettered is killed at start too, because no owner lives after a restart', async (context) => {
    const temp = trackedRunHome(context);
    const { pgid } = await seedTakenOverRun(context, temp, false);
    const marker = path.join(scopedPaths(temp).markers.tools, DEAD_LETTER_KEY);

    const launched = await launchRuntime(temp);

    expect(stepsLogged(launched.logger)).toContain('tool-markers');
    expect(await groupExists(pgid)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(idempotencyState(temp)).toBe('PENDING');
  });

  it('a real holder of a run dead-lettered before launch is killed at start', async (context) => {
    const temp = trackedRunHome(context);
    const { runId, pgid } = await seedTakenOverRun(context, temp, true);
    const marker = path.join(scopedPaths(temp).markers.tools, DEAD_LETTER_KEY);
    expect(deadLetterOf(temp, runId)).toEqual({ status: 'FAILED', dead_letter: 1 });

    const launched = await launchRuntime(temp);

    expect(stepsLogged(launched.logger)).toContain('tool-markers');
    expect(await groupExists(pgid)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(idempotencyState(temp)).toBe('PENDING');
  });
});
