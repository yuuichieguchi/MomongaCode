import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, pollUntil } from '@momonga/testkit';
import type { Sandbox, SandboxExit, SandboxedProcess } from '@momonga/sandbox';
import { systemRandom } from '@momonga/foundation';
import { ToolExecutionError } from '@momonga/tools';
import type { BackgroundJobAdopt, BackgroundJobs, ToolLimits } from '@momonga/tools';
import type { ChildPorts } from '../src/ports.ts';
import { HAS_REAL_SANDBOX } from './helpers.ts';
import { isAlive, makeBuiltins, resultOf, trackGroup } from './builtins/fixtures.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const WAIT_BOUND_MS = REAL_PROCESS_TEST_TIMEOUT_MS / 2;

type Armed = { callback: () => void; ms: number };

const fakeTimers = (): { port: ChildPorts; armed: Map<number, Armed>; fire(ms: number): void } => {
  const armed = new Map<number, Armed>();
  let next = 0;
  return {
    armed,
    port: {
      spawn: () => {
        throw new Error('this test starts no process through the child port');
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

const UNUSED_GROUP = 999_983;

const streamOf = () => {
  const queued: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const stream: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        for (;;) {
          const chunk = queued.shift();
          if (chunk !== undefined) return { done: false, value: chunk };
          if (ended) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      return: async () => {
        ended = true;
        return { done: true, value: undefined };
      },
    }),
  };
  const poke = (): void => {
    const woken = wake;
    wake = undefined;
    woken?.();
  };
  return {
    stream,
    write: (text: string) => {
      queued.push(Buffer.from(text));
      poke();
    },
    end: () => {
      ended = true;
      poke();
    },
  };
};

const fakeCommand = () => {
  const stdout = streamOf();
  const stderr = streamOf();
  let finish: (exit: SandboxExit) => void = () => undefined;
  let finished: SandboxExit | undefined;
  const exited = new Promise<SandboxExit>((resolve) => {
    finish = (exit) => {
      if (finished !== undefined) return;
      finished = exit;
      stdout.end();
      stderr.end();
      resolve(exit);
    };
  });
  let bound: { signal: AbortSignal; listener: () => void } | undefined;
  const rebound: AbortSignal[] = [];
  const bindTo = (signal: AbortSignal): void => {
    if (bound !== undefined) bound.signal.removeEventListener('abort', bound.listener);
    const listener = (): void => finish({ code: null, signal: 'SIGTERM', killedBy: 'abort', stop: 'confirmed' });
    bound = { signal, listener };
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) listener();
  };
  const process: SandboxedProcess = {
    pid: UNUSED_GROUP,
    pgid: UNUSED_GROUP,
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited,
    rebind: (signal) => {
      rebound.push(signal);
      bindTo(signal);
    },
  };
  let spawned = false;
  const sandbox: Sandbox = {
    kind: 'none',
    spawn: (_command, _policy, signal) => {
      spawned = true;
      bindTo(signal);
      return process;
    },
  };
  return { sandbox, process, rebound, write: stdout.write, finish, spawned: () => spawned, finished: () => finished };
};

const LIMITS: ToolLimits = {
  bash: { defaultTimeoutMs: 5_000, maxTimeoutMs: 10_000, onTimeout: 'background', backgroundTimeoutMs: 50_000, maxBackgroundTimeoutMs: 100_000 },
  search: { timeoutMs: 60_000 },
  operations: { timeoutMs: 120_000 },
};

type Adopted = { request: BackgroundJobAdopt; seen: string; followed: string[]; stop: AbortController; followDone: Promise<void> };

const adoptingJobs = (refusal?: string): { port: BackgroundJobs; adopted: Adopted[] } => {
  const adopted: Adopted[] = [];
  const port: BackgroundJobs = {
    start: () => {
      throw new Error('this test starts no background job');
    },
    adopt: async (request) => {
      if (refusal !== undefined) throw new ToolExecutionError(refusal);
      const stop = new AbortController();
      request.process.rebind(stop.signal);
      const entry: Adopted = { request, seen: Buffer.from(request.output.seen).toString('utf8'), followed: [], stop, followDone: Promise.resolve() };
      entry.followDone = request.output.follow((chunk) => void entry.followed.push(chunk.toString('utf8')));
      adopted.push(entry);
      return { jobId: 'bash_promoted' };
    },
    byCall: () => undefined,
    status: () => {
      throw new Error('unused');
    },
    read: () => {
      throw new Error('unused');
    },
    kill: () => {
      throw new Error('unused');
    },
  };
  return { port, adopted };
};

const timedHost = (timers: ChildPorts) => ({ shellHost: { platform: process.platform, isExecutable: () => true, child: timers } });

const NONCE = 'ab'.repeat(16);

const fixedNonce = { ...systemRandom, hex: (bytes: number) => 'ab'.repeat(bytes) };

const startBash = async (options: { limits?: ToolLimits; jobs?: BackgroundJobs; input?: Record<string, unknown>; deadlineMs?: number }) => {
  const timers = fakeTimers();
  const command = fakeCommand();
  const tools = await makeBuiltins({ sandbox: command.sandbox, ...(options.jobs === undefined ? {} : { jobs: options.jobs }), executor: { ...timedHost(timers.port), random: fixedNonce } });
  const extra = { limits: options.limits ?? LIMITS, ...(options.deadlineMs === undefined ? {} : { deadlineAt: tools.clock.now() + options.deadlineMs }) };
  const running = tools.run('Bash', { command: 'long-command', ...options.input }, extra, 'allow_once');
  await pollUntil(command.spawned, { description: 'the command was spawned', boundMs: WAIT_BOUND_MS });
  return { timers, command, tools, running };
};

const armedMs = (timers: { armed: Map<number, Armed> }): number[] => [...timers.armed.values()].map((timer) => timer.ms);

describe('a foreground Bash command that reaches its timeout', () => {
  it('becomes a background job that keeps running, with the output so far and the output after', async () => {
    const jobs = adoptingJobs();
    const { timers, command, running } = await startBash({ jobs: jobs.port });
    command.write('first\n');
    await pollUntil(() => armedMs(timers).includes(LIMITS.bash.defaultTimeoutMs), { description: 'the call timer is armed at the default', boundMs: WAIT_BOUND_MS });
    timers.fire(LIMITS.bash.defaultTimeoutMs);
    const result = resultOf(await running);
    expect(result.status).toBe('completed');
    expect(result.output).toContain('first');
    expect(result.output).toContain('moved to the background as bash_promoted');
    expect(jobs.adopted).toHaveLength(1);
    const [adopted] = jobs.adopted as [Adopted];
    expect(adopted.request.timeoutMs).toBe(LIMITS.bash.backgroundTimeoutMs);
    expect(adopted.seen).toContain('first');
    expect(command.rebound).toHaveLength(1);
    expect(command.finished()).toBeUndefined();
    command.write('second\n');
    await pollUntil(() => adopted.followed.join('').includes('second'), { description: 'the job reads the output written after the promotion', boundMs: WAIT_BOUND_MS });
    adopted.stop.abort();
    expect(command.finished()).toMatchObject({ signal: 'SIGTERM' });
    await adopted.followDone;
  });

  it('keeps the working-directory record of the shell out of the job output', async () => {
    const jobs = adoptingJobs();
    const { timers, command, running } = await startBash({ jobs: jobs.port });
    await pollUntil(() => armedMs(timers).includes(LIMITS.bash.defaultTimeoutMs), { description: 'the call timer is armed', boundMs: WAIT_BOUND_MS });
    timers.fire(LIMITS.bash.defaultTimeoutMs);
    resultOf(await running);
    const [adopted] = jobs.adopted as [Adopted];
    command.write('last line\n__MOMONGA_CW');
    command.write(`D_${NONCE}__=/somewhere\n`);
    await pollUntil(() => adopted.followed.join('').includes('last line'), { description: 'the job reads the last line', boundMs: WAIT_BOUND_MS });
    command.finish({ code: 0, signal: null });
    await adopted.followDone;
    expect(adopted.followed.join('')).toBe('last line\n');
  });

  it('is killed when tools.bash.onTimeout is kill', async () => {
    const jobs = adoptingJobs();
    const { timers, command, running } = await startBash({ jobs: jobs.port, limits: { ...LIMITS, bash: { ...LIMITS.bash, onTimeout: 'kill' } } });
    await pollUntil(() => armedMs(timers).includes(LIMITS.bash.defaultTimeoutMs), { description: 'the call timer is armed', boundMs: WAIT_BOUND_MS });
    timers.fire(LIMITS.bash.defaultTimeoutMs);
    const result = resultOf(await running);
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/timed out after 5000 ms/);
    expect(jobs.adopted).toHaveLength(0);
    expect(command.finished()).toMatchObject({ killedBy: 'abort' });
  });

  it('is killed, never promoted, when the run deadline comes first', async () => {
    const jobs = adoptingJobs();
    const { timers, command, running } = await startBash({ jobs: jobs.port, deadlineMs: 3_000 });
    await pollUntil(() => armedMs(timers).includes(3_000), { description: 'the timer is armed at the run deadline', boundMs: WAIT_BOUND_MS });
    timers.fire(3_000);
    const result = resultOf(await running);
    expect(result.status).toBe('failed');
    expect(jobs.adopted).toHaveLength(0);
    expect(command.finished()).toMatchObject({ killedBy: 'abort' });
  });

  it('is killed with the reason when the job cannot be adopted', async () => {
    const jobs = adoptingJobs('This session already has 8 running background jobs; stop one with KillBash before starting another');
    const { timers, command, running } = await startBash({ jobs: jobs.port });
    await pollUntil(() => armedMs(timers).includes(LIMITS.bash.defaultTimeoutMs), { description: 'the call timer is armed', boundMs: WAIT_BOUND_MS });
    timers.fire(LIMITS.bash.defaultTimeoutMs);
    const result = resultOf(await running);
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/timed out after 5000 ms/);
    expect(result.output).toContain('already has 8 running background jobs');
    expect(command.finished()).toMatchObject({ killedBy: 'abort' });
  });
});

describe('the Bash timeout comes from the settings', () => {
  it('a timeout above the maximum is reduced to the maximum and the result says so', async () => {
    const { timers, command, running } = await startBash({ input: { timeout: 20_000 } });
    await pollUntil(() => armedMs(timers).includes(LIMITS.bash.maxTimeoutMs), { description: 'the call timer is armed at the maximum', boundMs: WAIT_BOUND_MS });
    expect(armedMs(timers)).not.toContain(20_000);
    command.write('done\n');
    command.finish({ code: 0, signal: null, stop: 'confirmed' });
    const result = resultOf(await running);
    expect(result.status).toBe('completed');
    expect(result.output).toContain('timeout reduced to the configured maximum of 10000 ms');
  });

  it('a background job timeout above its maximum is reduced to that maximum', async () => {
    const started: number[] = [];
    const jobs: BackgroundJobs = {
      ...adoptingJobs().port,
      start: async (request) => {
        started.push(request.timeoutMs);
        return { jobId: 'bash_started' };
      },
    };
    const timers = fakeTimers();
    const tools = await makeBuiltins({ jobs, executor: timedHost(timers.port) });
    const result = resultOf(await tools.run('Bash', { command: 'long-command', run_in_background: true, timeout: 900_000 }, { limits: LIMITS }, 'allow_once'));
    expect(result.status).toBe('completed');
    expect(started).toEqual([LIMITS.bash.maxBackgroundTimeoutMs]);
    expect(result.output).toContain('timeout reduced to the configured maximum of 100000 ms');
  });
});

describe.runIf(HAS_REAL_SANDBOX)('a promoted command in the real sandbox', () => {
  it('outlives the call that started it and stops with its job', async () => {
    const jobs = adoptingJobs();
    const timers = fakeTimers();
    const tools = await makeBuiltins({ realSandbox: true, jobs: jobs.port, executor: timedHost(timers.port) });
    const running = tools.run('Bash', { command: 'echo started; exec sleep 30' }, { limits: LIMITS }, 'allow_once');
    const groups = (): number[] => tools.idempotency.log.flatMap((entry) => (entry.op === 'attachProcess' ? [entry.pgid] : []));
    await pollUntil(() => groups().length > 0, { description: 'the command group is attached', boundMs: REAL_PROCESS_TEST_TIMEOUT_MS / 2 });
    const [group] = groups() as [number];
    trackGroup(group);
    await pollUntil(() => armedMs(timers).includes(LIMITS.bash.defaultTimeoutMs), { description: 'the call timer is armed', boundMs: WAIT_BOUND_MS });
    timers.fire(LIMITS.bash.defaultTimeoutMs);
    const result = resultOf(await running);
    expect(result.status).toBe('completed');
    expect(result.output).toContain('moved to the background as bash_promoted');
    expect(isAlive(-group)).toBe(true);
    const [adopted] = jobs.adopted as [Adopted];
    adopted.stop.abort();
    await adopted.request.process.exited;
    await pollUntil(() => !isAlive(-group), { description: 'the job stopped the command group', boundMs: REAL_PROCESS_TEST_TIMEOUT_MS / 2 });
  });
});
