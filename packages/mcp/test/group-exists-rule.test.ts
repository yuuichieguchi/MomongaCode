import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessGroupPort, terminateGroup } from '@momonga/foundation';
import type { CommandRunner, GroupTiming } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { groupExists as harnessGroupExists } from './mcp-harness.ts';
import { groupExists as rawGroupExists } from './raw-transport.ts';

const PGID = 1_999_999_011;

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`kill ${code}`), { code });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the test harness asks whether a group exists by the product rule: alive only while a member can still run', () => {
  it('after a stop ends as killed with its only member still exiting, kill(-pgid, 0) gives EPERM and the harness reads the group as gone', async () => {
    let memberStat = 'S';
    vi.spyOn(process, 'kill').mockImplementation((target: number, signal?: string | number) => {
      if (target !== -PGID) throw errno('ESRCH');
      if (memberStat.includes('E')) throw errno('EPERM');
      if (signal === 'SIGKILL') memberStat = '?E';
      return true;
    });
    const ps: CommandRunner = async () => ({ exitCode: 0, stdout: `${PGID} ${memberStat}\n`, stderr: '' });
    const clock = createFakeClock(0);
    const timing: GroupTiming = { now: () => clock.now(), sleep: async (ms) => void clock.advance(ms) };
    const port = createProcessGroupPort('darwin', { run: ps, env: {} });
    expect(await terminateGroup(PGID, { graceMs: 100, port, timing, signal: new AbortController().signal })).toBe('killed');
    expect(memberStat).toBe('?E');
    expect(await harnessGroupExists(PGID)).toBe(false);
    expect(await rawGroupExists(PGID)).toBe(false);
  });
});
