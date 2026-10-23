import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureMomongaDirs } from '@momonga/foundation';
import { openRuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, trackGroup } from './helpers.ts';
import { RUNTIME_VERSION, captureStream, failureOf, hookLogger, isLockFree, launchRuntime, prepareStack, startRuntimeProcess, stepsLogged } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

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

const PROCESS_TIMEOUT = { timeout: 60_000 };
const SEED_MS = START_MS;

beforeEach(() => {
  control.lookupError = undefined;
});

const groupExists = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

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
  await ensureMomongaDirs(temp.paths);
  const store = openRuntimeStore({ path: temp.paths.databases.runtime, home: temp.home, clock: createFakeClock(SEED_MS), leaseMs: 30_000, maxAttempts: 5, maxTotalAttempts: 20 });
  try {
    seed(store);
  } finally {
    store.close();
  }
};

const keyOf = (letter: string): string => letter.repeat(64);

describe('startup marker reaping through startRuntimeProcess (real processes, system timers)', () => {
  it('reaps MCP markers left by a killed instance at start', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack();
    await ensureMomongaDirs(stack.temp.paths);
    const marker = path.join(stack.temp.paths.markers.mcp, 'fx-left-behind');
    const pgid = spawnHolder(marker, (pid) => `${pid}\n`);
    expect(groupExists(pgid)).toBe(true);
    const launched = await launchRuntime(stack.temp);
    expect(stepsLogged(launched.logger)).toContain('mcp-markers');
    expect(groupExists(pgid)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('tool markers are reaped at start by record state: COMPLETED, missing and UNKNOWN holders are reaped, PENDING is kept, holder-less markers are deleted', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack();
    await ensureMomongaDirs(stack.temp.paths);
    const markers = stack.temp.paths.markers.tools;
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
    expect(groupExists(holders['completed'] as number)).toBe(false);
    expect(groupExists(holders['missing'] as number)).toBe(false);
    expect(groupExists(holders['unknown'] as number)).toBe(false);
    expect(groupExists(holders['pending'] as number)).toBe(true);
    expect(fs.readdirSync(markers).sort()).toEqual([keyOf('d')]);
  });

  it('a store error during tool-marker reaping fails startup before any process is signalled and unwinds', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack();
    await ensureMomongaDirs(stack.temp.paths);
    const holder = spawnHolder(path.join(stack.temp.paths.markers.tools, keyOf('f')));
    const injected = Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11 });
    control.lookupError = injected;
    const logger = hookLogger(() => undefined);
    const stdout = captureStream();
    const error = await failureOf(startRuntimeProcess({ home: stack.temp.home, version: RUNTIME_VERSION, logger, stdout }));
    expect(error).toBe(injected);
    expect(stepsLogged(logger).at(-1)).toBe('tool-markers');
    expect(stepsLogged(logger, 'teardown.step')).toEqual(['store', 'lock']);
    expect(groupExists(holder)).toBe(true);
    expect(isLockFree(stack.temp.paths.locks.runtime)).toBe(true);
    expect(stdout.chunks).toEqual([]);
  });
});
