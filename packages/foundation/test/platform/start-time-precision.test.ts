import { describe, expect, it } from 'vitest';
import { createLinuxInspector } from '../../src/platform/linux-inspector.ts';
import { auxvLayoutOf } from '../../src/platform/linux-parsers.ts';
import type { ProcFs } from '../../src/platform/procfs.ts';
import { createWindowsInspector } from '../../src/platform/windows-inspector.ts';
import { startTimeScript } from '../../src/platform/windows-scripts.ts';

const LIVE = { signal: new AbortController().signal };

const auxvWithClockTicks = (ticksPerSecond: bigint): Uint8Array => {
  const view = new DataView(new ArrayBuffer(48));
  const pairs: Array<[bigint, bigint]> = [
    [33n, 1n],
    [17n, ticksPerSecond],
    [0n, 0n],
  ];
  pairs.forEach(([type, value], index) => {
    view.setBigUint64(index * 16, type, true);
    view.setBigUint64(index * 16 + 8, value, true);
  });
  return new Uint8Array(view.buffer);
};

const statWithStartTicks = (pid: number, ticks: number): string =>
  `${pid} (sleep) S 1 ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 5517312 189 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0`;

const procfsOf = (texts: Record<string, string>, ticksPerSecond: bigint): ProcFs => {
  const missing = (): never => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  return {
    readText: async (file) => texts[file] ?? missing(),
    readBytes: async (file) => (file === '/proc/self/auxv' ? auxvWithClockTicks(ticksPerSecond) : missing()),
    list: async () => missing(),
    identityOf: async () => missing(),
    birthMsOf: async () => 0,
  };
};

describe('Linux start times are compared as exact starttime ticks', () => {
  it('tells apart two processes one tick apart when a tick is shorter than a millisecond', async () => {
    const inspector = createLinuxInspector({
      procfs: procfsOf(
        {
          '/proc/stat': 'cpu  1 2 3 4\nbtime 1700000000\n',
          '/proc/101/stat': statWithStartTicks(101, 3001),
          '/proc/102/stat': statWithStartTicks(102, 3002),
          '/proc/103/stat': statWithStartTicks(103, 3001),
        },
        3000n,
      ),
      layout: auxvLayoutOf('x64', 'LE'),
      uid: 1000,
    });
    const first = await inspector.startTimeOf(101, LIVE);
    const oneTickLater = await inspector.startTimeOf(102, LIVE);
    const sameTick = await inspector.startTimeOf(103, LIVE);
    expect(first.kind).toBe('value');
    expect(oneTickLater).not.toEqual(first);
    expect(sameTick).toEqual(first);
  });
});

describe('Windows start times are compared as the FILETIME at 100 ns', () => {
  const runnerPrinting = (stdout: string) => async () => ({ exitCode: 0, stdout, stderr: '' });
  const ENV = { SystemRoot: 'C:\\Windows' };

  it('reads the creation time through GetProcessTimes, not as Unix milliseconds', () => {
    const script = startTimeScript(42);
    expect(script).toContain('GetProcessTimes');
    expect(script).not.toContain('ToUnixTimeMilliseconds');
  });

  it('tells apart two creation times 100 ns apart', async () => {
    const first = await createWindowsInspector({ run: runnerPrinting('133400000000000001\r\n'), env: ENV, groups: { members: async () => [] }, alive: () => false }).startTimeOf(321, LIVE);
    const hundredNanosecondsLater = await createWindowsInspector({ run: runnerPrinting('133400000000000002\r\n'), env: ENV, groups: { members: async () => [] }, alive: () => false }).startTimeOf(321, LIVE);
    const same = await createWindowsInspector({ run: runnerPrinting('133400000000000001\r\n'), env: ENV, groups: { members: async () => [] }, alive: () => false }).startTimeOf(321, LIVE);
    expect(first.kind).toBe('value');
    expect(hundredNanosecondsLater).not.toEqual(first);
    expect(same).toEqual(first);
  });
});
