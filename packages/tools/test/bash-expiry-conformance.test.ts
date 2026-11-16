import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, pollUntil } from '@momonga/testkit';
import type { Sandbox, SandboxExit, SandboxedProcess } from '@momonga/sandbox';
import { systemRandom } from '@momonga/foundation';
import { ToolExecutionError } from '@momonga/tools';
import type { BackgroundJobAdopt, BackgroundJobs, ToolLimits } from '@momonga/tools';
import type { ChildPorts } from '../src/ports.ts';
import { makeBuiltins, resultOf } from './builtins/fixtures.ts';
import { cfgNames } from '../../../test/formal/cfg-names.ts';

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
  bash: { defaultTimeoutMs: 5_000, maxTimeoutMs: 10_000, onTimeout: 'background', backgroundTimeoutMs: 50_000, maxBackgroundTimeoutMs: 100_000, drainIdleMs: 1000 },
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
      request.output.follow((chunk) => void entry.followed.push(chunk.toString('utf8')));
      entry.followDone = request.output.drainAfterExit(request.drainIdleMs, new AbortController().signal).then(() => request.output.close());
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

const fixedNonce = { ...systemRandom, hex: (bytes: number) => 'ab'.repeat(bytes) };

const startBash = async (options: { limits?: ToolLimits; jobs?: BackgroundJobs; input?: Record<string, unknown>; deadlineMs?: number; signal?: AbortSignal }) => {
  const timers = fakeTimers();
  const command = fakeCommand();
  const tools = await makeBuiltins({ sandbox: command.sandbox, ...(options.jobs === undefined ? {} : { jobs: options.jobs }), executor: { ...timedHost(timers.port), random: fixedNonce } });
  const extra = { limits: options.limits ?? LIMITS, ...(options.deadlineMs === undefined ? {} : { deadlineAt: tools.clock.now() + options.deadlineMs }), ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const running = tools.run('Bash', { command: 'long-command', ...options.input }, extra, 'allow_once');
  await pollUntil(command.spawned, { description: 'the command was spawned', boundMs: WAIT_BOUND_MS });
  return { timers, command, tools, running };
};

const armedMs = (timers: { armed: Map<number, Armed> }): number[] => [...timers.armed.values()].map((timer) => timer.ms);


const model = cfgNames(path.resolve(import.meta.dirname, '..', '..', '..', 'specs', 'tla'), 'BashExpiry');

type Cause = 'callTimeout' | 'runDeadline' | 'cancel';

const expire = async (cause: Cause, policy: 'background' | 'kill', refusal: string | undefined) => {
  const jobs = adoptingJobs(refusal);
  const cancel = new AbortController();
  const limits: ToolLimits = { ...LIMITS, bash: { ...LIMITS.bash, onTimeout: policy } };
  const deadlineMs = LIMITS.bash.defaultTimeoutMs / 2;
  const { timers, command, running } = await startBash({ jobs: jobs.port, limits, signal: cancel.signal, ...(cause === 'runDeadline' ? { deadlineMs } : {}) });
  const firstMs = cause === 'runDeadline' ? deadlineMs : LIMITS.bash.defaultTimeoutMs;
  await pollUntil(() => armedMs(timers).includes(firstMs), { description: 'the call timer is armed', boundMs: WAIT_BOUND_MS });
  if (cause === 'cancel') cancel.abort();
  else timers.fire(firstMs);
  const result = resultOf(await running);
  return { result, jobs, command, cancel };
};

describe('the Bash tool on the cases of specs/tla/BashExpiry.tla', () => {
  it('the design configuration checks the invariants these cases run', () => {
    expect(model.constants['Policy']).toBe('"background"');
    expect(model.constants['Promote']).toBe('"callTimeout"');
    expect(model.invariants).toEqual(expect.arrayContaining(['OneOwner', 'OwnedWhileLive', 'OnlyCallTimeoutPromotes', 'CancelWinsInHandoff', 'JobCap']));
  });

  it('OnlyCallTimeoutPromotes, OwnedWhileLive, JobCap: on every expiry cause, policy and adoption answer, the command becomes a job exactly when its own call timeout fired under the background policy and the job was taken; otherwise it is stopped and its call does not complete', async () => {
    const problems: string[] = [];
    for (const cause of ['callTimeout', 'runDeadline', 'cancel'] as const) {
      for (const policy of ['background', 'kill'] as const) {
        for (const refusal of [undefined, 'This session already has 8 running background jobs; stop one with KillBash before starting another']) {
          const label = `${cause} ${policy} ${refusal === undefined ? 'taken' : 'refused'}`;
          const { result, jobs, command } = await expire(cause, policy, refusal);
          const promoted = cause === 'callTimeout' && policy === 'background' && refusal === undefined;
          if ((jobs.adopted.length === 1) !== promoted) problems.push(`${label}: adopted ${jobs.adopted.length}`);
          if (promoted) {
            if (command.finished() !== undefined) problems.push(`${label}: the promoted command was stopped`);
            if (result.status !== 'completed') problems.push(`${label}: the call of a promoted command ended ${result.status}`);
            jobs.adopted[0]?.stop.abort();
          } else {
            if (command.finished() === undefined) problems.push(`${label}: OwnedWhileLive, the command runs with no owner`);
            if (result.status === 'completed') problems.push(`${label}: a stopped command is reported completed`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('OneOwner: after the handoff the call no longer owns the process, so the signal of the ended call does not stop the job, and the stop of the job does', async () => {
    const { jobs, command, cancel } = await expire('callTimeout', 'background', undefined);
    expect(command.rebound).toHaveLength(1);
    cancel.abort();
    expect(command.finished()).toBeUndefined();
    jobs.adopted[0]?.stop.abort();
    expect(command.finished()).toMatchObject({ killedBy: 'abort' });
  });
});
