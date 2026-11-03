import { describe, expect, it } from 'vitest';
import { hostPidOf } from './process.ts';
import type { ProcView } from './process.ts';

const HOST = 'pid:[1]';
const SANDBOX = 'pid:[2]';

const viewOf = (processes: Record<number, { namespace: string; innermost: number }>, own: string | null = HOST): ProcView => ({
  pids: () => Object.keys(processes).map(Number),
  pidNamespaceOf: (pid) => (pid === process.pid ? (own ?? undefined) : processes[pid]?.namespace),
  innermostPidOf: (pid) => processes[pid]?.innermost,
});

describe('hostPidOf', () => {
  const sandboxed = viewOf({
    13879: { namespace: HOST, innermost: 13879 },
    13880: { namespace: SANDBOX, innermost: 1 },
    13881: { namespace: SANDBOX, innermost: 2 },
    13882: { namespace: SANDBOX, innermost: 3 },
    20002: { namespace: 'pid:[3]', innermost: 2 },
  });

  it('maps a pid printed inside the sandbox pid namespace to the host pid of the same process', () => {
    expect(hostPidOf(2, 13880, sandboxed)).toBe(13881);
    expect(hostPidOf(3, 13880, sandboxed)).toBe(13882);
  });

  it('never matches a process of another pid namespace that has the same inner pid', () => {
    expect(hostPidOf(2, 13882, sandboxed)).not.toBe(20002);
  });

  it('answers undefined while no process of the sandbox has that inner pid', () => {
    expect(hostPidOf(9, 13880, sandboxed)).toBeUndefined();
  });

  it('keeps the pid when the sandbox shares the host pid namespace', () => {
    expect(hostPidOf(13879, 13879, sandboxed)).toBe(13879);
  });

  it('keeps the pid on a host without pid namespaces', () => {
    expect(hostPidOf(4242, 4243, viewOf({}, null))).toBe(4242);
  });

  it('refuses to guess when the process that names the sandbox namespace is gone', () => {
    expect(() => hostPidOf(2, 99999, sandboxed)).toThrow(/99999/);
  });
});
