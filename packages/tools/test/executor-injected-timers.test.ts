import { describe, expect, it } from 'vitest';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { Random } from '@momonga/foundation';
import { TransientToolError } from '@momonga/tools';
import type { ToolContext } from '@momonga/tools';
import type { ChildPorts } from '../src/ports.ts';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

type Armed = { callback: () => void; ms: number };

const fakeChild = (): { port: ChildPorts; armed: Map<number, Armed>; fire(ms: number): void } => {
  const armed = new Map<number, Armed>();
  let next = 0;
  return {
    armed,
    port: {
      spawn: () => {
        throw new Error('this test starts no process');
      },
      setTimeout: (callback, ms) => {
        next += 1;
        armed.set(next, { callback, ms });
        return next;
      },
      clearTimeout: (handle) => void armed.delete(handle as number),
    },
    fire: (ms) => {
      for (const [handle, timer] of [...armed]) {
        if (timer.ms !== ms) continue;
        armed.delete(handle);
        timer.callback();
      }
    },
  };
};

const entering = (): { entered: Promise<void>; enter(): void } => {
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return { entered, enter };
};

const waitForAbort = (ctx: ToolContext): Promise<{ status: 'failed'; output: string }> =>
  new Promise((resolve) => {
    ctx.signal.addEventListener('abort', () => resolve({ status: 'failed', output: 'aborted by signal' }), { once: true });
  });

const HOUR_MS = 60 * 60 * 1000;
const LIMIT_MS = 120_000;
const RETRY_MS = 7_000;

const hostWith = (child: ChildPorts) => ({ shellHost: { platform: process.platform, isExecutable: () => true, child }, files: nodeFileSystem });

describe('the executor keeps time through its injected ports', () => {
  it('a call expires when the injected timer of its limit fires, with no real wait', async () => {
    const timers = fakeChild();
    const harness = makeHarness({ executor: { ...hostWith(timers.port), random: systemRandom } });
    const gate = entering();
    const tool = makeTool('Slow', {
      timeoutMs: LIMIT_MS,
      execute: (_input, ctx) => {
        gate.enter();
        return waitForAbort(ctx);
      },
    });
    const running = harness.executor.runBatch({ ...(await harness.input(await toolSetOf(tool), [call('c1', 'Slow', {})])), deadlineAt: harness.clock.now() + HOUR_MS });
    await gate.entered;
    expect([...timers.armed.values()].map((timer) => timer.ms)).toContain(LIMIT_MS);
    harness.clock.set(harness.clock.now() + LIMIT_MS);
    timers.fire(LIMIT_MS);
    const [outcome] = await running;
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'failed' } });
    expect((outcome as { result: { output: string } }).result.output).toMatch(/timed out after 120000 ms/);
  });

  it('the pause before a retry of a read-only call is the injected timer, with the jitter of the injected random', async () => {
    const timers = fakeChild();
    const floats: number[] = [];
    const random: Random = {
      ...systemRandom,
      float: () => {
        floats.push(1);
        return 0.5;
      },
    };
    const harness = makeHarness({ executor: { ...hostWith(timers.port), random, readOnlyRetry: { attempts: 2, baseMs: RETRY_MS, maxMs: RETRY_MS } } });
    const first = entering();
    let attempts = 0;
    const tool = makeTool('Flaky', {
      timeoutMs: LIMIT_MS,
      execute: async () => {
        attempts += 1;
        if (attempts === 1) {
          first.enter();
          throw new TransientToolError('try again');
        }
        return { status: 'completed', output: 'second attempt' };
      },
    });
    const running = harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Flaky', {})]));
    await first.entered;
    const pauses = (): number[] => [...timers.armed.values()].map((timer) => timer.ms).filter((ms) => ms !== LIMIT_MS);
    await expect.poll(pauses).toHaveLength(1);
    expect(floats.length).toBeGreaterThan(0);
    expect(pauses()).toEqual([RETRY_MS / 2]);
    timers.fire(RETRY_MS / 2);
    const [outcome] = await running;
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'second attempt' } });
  });
});
