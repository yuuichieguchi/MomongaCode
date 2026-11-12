import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLockCapability, createMarker, createProcessInspector, hostInspectorPorts, POLL_INTERVAL_MS, systemWaitTiming, waitUntil } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, testLocks } from '@momonga/testkit';
import { launch } from '../src/process.ts';
import type { LaunchOptions } from '../src/process.ts';
import { makeTempDir } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

const forbiddenRunner = async (file: string): Promise<never> => {
  throw new Error(`the lock path must not start ${file}`);
};

const live = () => ({ signal: new AbortController().signal });

const setup = async () => {
  const root = fs.realpathSync(makeTempDir());
  const proofDir = path.join(root, 'lock-proof');
  const markerDir = path.join(root, 'markers');
  fs.mkdirSync(proofDir, { mode: 0o700 });
  fs.mkdirSync(markerDir);
  const capability = createLockCapability({ proofDir });
  const inspector = createProcessInspector(process.platform, { ...hostInspectorPorts(testLocks().capability), run: forbiddenRunner, capability });
  return { root, markerDir, capability, inspector };
};

const launchWith = (root: string, markerFd: number, script: string, extra: Partial<LaunchOptions> = {}) =>
  launch({
    file: '/bin/bash',
    args: ['-c', script],
    cwd: root,
    env: BASE_ENV,
    signal: new AbortController().signal,
    killGraceMs: 300,
    afterExit: () => undefined,
    markerFd,
    ...extra,
  } as LaunchOptions);

const STATE_POLL_MS = 50;

const waitForState = async (read: () => Promise<string>, wanted: string, attempts: number): Promise<string> => {
  let last = await read();
  await waitUntil(
    systemWaitTiming,
    async () => {
      last = await read();
      return last === wanted ? last : undefined;
    },
    { intervalMs: POLL_INTERVAL_MS, deadline: systemWaitTiming.monotonicMs() + attempts * STATE_POLL_MS },
  );
  return last;
};

describe.runIf(process.platform === 'darwin')('T3 (a) a real launch with a created-and-locked marker', () => {
  it('reads held after the leader exits while an escaped grandchild keeps fd 3, and free once it exits, without any subprocess probe', async () => {
    const { root, markerDir, capability, inspector } = await setup();
    expect(await capability.of(markerDir)).toBe('proved');
    const marker = path.join(markerDir, 'call');
    const handle = await createMarker(marker, { capability });
    expect(handle.mode).toBe('locked');
    const ready = path.join(root, 'ready');
    const child = await launchWith(root, handle.fd, `perl -e 'use POSIX; POSIX::setsid(); open(my $f, ">", $ARGV[0]); close $f; sleep 1' ${ready} >/dev/null 2>&1 & while [ ! -e ${ready} ]; do sleep 0.02; done; exit 0`);
    try {
      expect(() => fs.fstatSync(handle.fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
      expect(await child.exited).toMatchObject({ code: 0 });
      expect(await inspector.markerState(marker, live())).toBe('held');
      expect(await waitForState(() => inspector.markerState(marker, live()), 'free', 200)).toBe('free');
    } finally {
      handle.close();
      await killGroupsForCleanup([child.pgid]);
    }
  });
});

describe.runIf(process.platform === 'darwin')('T13 launch closes the parent copy of the marker descriptor on every path', () => {
  it('a spawn that throws leaves the marker free: the parent copy is closed in the finally around spawn', async () => {
    const { root, markerDir, capability, inspector } = await setup();
    const marker = path.join(markerDir, 'refused');
    const handle = await createMarker(marker, { capability });
    const failingSpawn = (() => {
      throw new Error('spawn failed: injected');
    }) as unknown as NonNullable<LaunchOptions['spawnProcess']>;
    await expect(launchWith(root, handle.fd, 'exit 0', { spawnProcess: failingSpawn })).rejects.toThrow('spawn failed: injected');
    expect(() => fs.fstatSync(handle.fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
    expect(await inspector.markerState(marker, live())).toBe('free');
    handle.close();
  });
});
