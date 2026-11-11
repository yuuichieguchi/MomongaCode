import { describe, expect, it } from 'vitest';
import { fakePolicyFilesystem, hostFilesystemOf } from '@momonga/testkit';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const commandTool = (command: string, runs: string[]) =>
  makeTool('Bash', {
    kind: 'execute',
    sideEffect: 'exec', subjectKind: 'command',
    subject: () => ({ kind: 'command', tool: 'Bash', command }),
    execute: async () => {
      runs.push(command);
      return { status: 'completed', output: 'ran' };
    },
  });

const recordingFilesystem = () => {
  const deadlines: Array<() => number> = [];
  const host = hostFilesystemOf(fakePolicyFilesystem());
  const fs = {
    ...host,
    expandGlob: async (pattern: string, cwd: string, limit: number, deadline: { remainingMs: () => number }) => {
      deadlines.push(() => deadline.remainingMs());
      return host.expandGlob(pattern, cwd, limit, deadline);
    },
  };
  return { fs, deadlines };
};

describe('the executor spends one glob budget per decision, derived from the lease (HIGH-1)', () => {
  it.each([
    [30_000, 10_000, 20_000],
    [120_000, 40_000, 80_000],
  ])('lease %d with heartbeat %d gives the expansions at most %d ms', async (leaseMs, heartbeatMs, budget) => {
    const { fs, deadlines } = recordingFilesystem();
    const harness = makeHarness({ executor: { fs, leaseMs, heartbeatMs } });
    const runs: string[] = [];
    await harness.executor.runBatch(await harness.input(await toolSetOf(commandTool('cat a* b*', runs)), [call('c1', 'Bash')]));
    expect(deadlines).toHaveLength(2);
    const [first, second] = deadlines.map((remaining) => remaining());
    expect(first).toBeLessThanOrEqual(budget);
    expect(first).toBeGreaterThan(budget - 5_000);
    expect(second).toBeLessThanOrEqual(budget);
  });

  it('shares one deadline between the words of one decision', async () => {
    const seen: unknown[] = [];
    const host = hostFilesystemOf(fakePolicyFilesystem());
    const fs = {
      ...host,
      expandGlob: async (pattern: string, cwd: string, limit: number, deadline: { remainingMs: () => number }) => {
        seen.push(deadline);
        return host.expandGlob(pattern, cwd, limit, deadline);
      },
    };
    const harness = makeHarness({ executor: { fs } });
    await harness.executor.runBatch(await harness.input(await toolSetOf(commandTool('cat a* b*', [])), [call('c1', 'Bash')]));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('asks when the expansion reaches its deadline, and runs nothing', async () => {
    const host = hostFilesystemOf(fakePolicyFilesystem());
    const fs = { ...host, expandGlob: async () => ({ unresolvable: { kind: 'dynamic' as const } }) };
    const harness = makeHarness({ executor: { fs } });
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(commandTool('cat a*', runs)), [call('c1', 'Bash')]));
    expect(outcome).toMatchObject({ kind: 'needs_approval' });
    expect(runs).toEqual([]);
  });

  it('hands the batch signal to the expander, and a cancel during the expansion fails the call as cancelled and runs nothing', async () => {
    const host = hostFilesystemOf(fakePolicyFilesystem());
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const fs = {
      ...host,
      expandGlob: (_pattern: string, _cwd: string, _limit: number, _deadline: unknown, signal: AbortSignal) => {
        received = signal;
        return new Promise<{ unresolvable: { kind: 'dynamic' } }>((resolve) => {
          signal.addEventListener('abort', () => resolve({ unresolvable: { kind: 'dynamic' } }), { once: true });
          controller.abort();
        });
      },
    };
    const harness = makeHarness({ executor: { fs } });
    const runs: string[] = [];
    const [outcome] = await harness.executor.runBatch(await harness.input(await toolSetOf(commandTool('cat a*', runs)), [call('c1', 'Bash')], { signal: controller.signal }));
    expect(received).toBe(controller.signal);
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed', output: expect.stringContaining('cancelled') } });
    expect(runs).toEqual([]);
  });

  it('rethrows an error of the expander and runs nothing', async () => {
    const failure = Object.assign(new Error('EIO: injected'), { code: 'EIO' });
    const host = hostFilesystemOf(fakePolicyFilesystem());
    const fs = {
      ...host,
      expandGlob: async (): Promise<never> => {
        throw failure;
      },
    };
    const harness = makeHarness({ executor: { fs } });
    const runs: string[] = [];
    await expect(harness.executor.runBatch(await harness.input(await toolSetOf(commandTool('cat a*', runs)), [call('c1', 'Bash')]))).rejects.toBe(failure);
    expect(runs).toEqual([]);
  });
});
