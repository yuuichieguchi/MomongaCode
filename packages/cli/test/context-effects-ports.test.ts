import os from 'node:os';
import type fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MomongaPaths, ProcessPort } from '@momonga/foundation';
import { shortTempBase } from '@momonga/foundation';
import { nodeContextEffects } from '../src/eval/context-effects.ts';
import { ROOT_PREFIX } from '../src/eval/context-host.ts';
import { nodeClock, nodeFilesLockedBy } from '../src/node-ports.ts';
import type { CliClock, CliPorts } from '../src/ports.ts';
import { setupGenerations } from './generations-harness.ts';
import { testKernelLock } from '@momonga/testkit';

type Sent = { pid: number; signal: NodeJS.Signals };

const FAKE_PID = 4242;

const fakeProcess = (alive: Set<number>, uid: number | undefined = 501): { sent: Sent[]; port: ProcessPort } => {
  const sent: Sent[] = [];
  return {
    sent,
    port: {
      pid: FAKE_PID,
      uid: () => uid,
      runState: null,
      kill: (pid, signal) => {
        if (signal !== 0) {
          sent.push({ pid, signal });
          alive.delete(pid);
          return;
        }
        if (!alive.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      },
    },
  };
};

const jumpingClock = (): CliClock & { slept: number[] } => {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += 1_000_000;
    },
  };
};

const portsOf = (given: Partial<CliPorts>): CliPorts => ({ platform: 'linux', env: {}, home: '/home/person', files: nodeFilesLockedBy(testKernelLock), clock: jumpingClock(), process: fakeProcess(new Set()).port, ...given }) as CliPorts;

afterEach(() => {
  vi.useRealTimers();
});

describe('the host effects of an eval reach the process only through the process port', () => {
  it('names the pid of the process port as the owner of a case home', () => {
    expect(nodeContextEffects(portsOf({}), testKernelLock()).ownerPid).toBe(FAKE_PID);
  });

  it('lists the case homes of the user the process port names, read through the file port', async () => {
    const listed: string[] = [];
    const files = {
      ...nodeFilesLockedBy(testKernelLock),
      readdir: async (directory: string) => {
        listed.push(directory);
        return [`${ROOT_PREFIX}mine`, `${ROOT_PREFIX}theirs`, 'unrelated'];
      },
      lstat: async (file: string) => ({ isDirectory: () => true, uid: file.endsWith('mine') ? 777 : 778 }) as fs.Stats,
    };

    const roots = await nodeContextEffects(portsOf({ files, process: fakeProcess(new Set(), 777).port }), testKernelLock()).listRoots();

    expect(listed).toEqual([shortTempBase('linux', '/unused-on-linux')]);
    expect(roots.map((root) => root.slice(root.lastIndexOf(ROOT_PREFIX)))).toEqual([`${ROOT_PREFIX}mine`]);
  });

  it('resolves a directory through the file port', async () => {
    const files = { ...nodeFilesLockedBy(testKernelLock), realpath: async (file: string) => `/real${file}` };

    expect(await nodeContextEffects(portsOf({ files }), testKernelLock()).canonical('/case/home')).toBe('/real/case/home');
  });

  it('waits through the clock port', async () => {
    const clock = jumpingClock();

    await nodeContextEffects(portsOf({ clock }), testKernelLock()).after(250, new AbortController().signal);

    expect(clock.slept).toEqual([250]);
  });
});

describe('the teardown of a case home signals through the process port', () => {
  it('sends the stop signal to the supervisor that holds the generation and returns when the port reports it gone', async (context) => {
    const { paths, start } = await setupGenerations(context, '1.2.4');
    await start({ version: '1.2.4', generation: 1 });
    const fake = fakeProcess(new Set([process.pid]));

    await nodeContextEffects(portsOf({ process: fake.port }), testKernelLock()).terminate(paths as MomongaPaths);

    expect(fake.sent).toEqual([{ pid: process.pid, signal: 'SIGTERM' }]);
  });
});

describe('the sleep of the production clock', () => {
  const LONGEST_HOST_TIMER_MS = 2_147_483_647;

  it('lasts its whole duration when that is longer than one timer of the host can run', async () => {
    vi.useFakeTimers();
    let woke = false;
    const sleeping = nodeClock.sleep(LONGEST_HOST_TIMER_MS + 5).then(() => {
      woke = true;
    });

    await vi.advanceTimersByTimeAsync(LONGEST_HOST_TIMER_MS);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    await sleeping;

    expect(woke).toBe(true);
  });
});
