import type { Claim } from '@momonga/store';
import type { RunMemory } from './claim-context.ts';
import type { ClaimControl } from './claim-control.ts';
import { runClaim } from './claim-runner.ts';
import type { ClaimHost } from './claim-runner.ts';
import { describeError } from './errors.ts';
import type { Worker, WorkerErrorContext, WorkerOptions } from './types.ts';

const DEFAULT_IDLE_POLL_MS = 250;
const TERMINAL_STATUSES: readonly string[] = ['COMPLETED', 'STOPPED', 'FAILED', 'CANCELLED'];

export const createWorker = (options: WorkerOptions): Worker => {
  const idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
  let stopping = false;
  let loop: Promise<void> | undefined;
  let interruptSleep: (() => void) | undefined;
  let wakePending = false;
  let unsubscribeWake: (() => void) | undefined;
  let aborted = false;
  const controls = new Set<ClaimControl>();
  const inFlight = new Set<Promise<unknown>>();
  const memories = new Map<string, RunMemory>();

  const host: ClaimHost = {
    attach: (control) => {
      controls.add(control);
      return () => controls.delete(control);
    },
    memoryOf: (runId) => {
      const existing = memories.get(runId);
      if (existing !== undefined) return existing;
      const created: RunMemory = { streak: 0, interruptions: 0, deadlineAt: Number.POSITIVE_INFINITY };
      memories.set(runId, created);
      return created;
    },
    forget: (runId) => memories.delete(runId),
  };

  const noticeOnClaim = (message: string, claim: Claim): void => {
    try {
      options.store.append(claim, [{ type: 'notice', level: 'error', message }]);
    } catch {
      return;
    }
  };

  const report = (error: unknown, context: WorkerErrorContext, claim: Claim | null): void => {
    let message = `The worker failed on this run: ${describeError(error)}`;
    try {
      options.onError?.(error, context);
    } catch (hookError) {
      message = `${message} (the error hook also failed: ${describeError(hookError)})`;
    }
    if (claim !== null) noticeOnClaim(message, claim);
  };

  const runOnce = async (onClaim?: (claim: Claim) => void): Promise<'idle' | 'yielded'> => {
    if (aborted || stopping) return 'idle';
    const claim = options.store.claim(options.workerId);
    if (claim === null) return 'idle';
    onClaim?.(claim);
    const running = runClaim(options, claim, host);
    inFlight.add(running);
    try {
      await running;
    } finally {
      inFlight.delete(running);
    }
    return 'yielded';
  };

  const pollOnce = async (): Promise<'idle' | 'yielded'> => {
    const attempt: { claim: Claim | null } = { claim: null };
    try {
      return await runOnce((claim) => {
        attempt.claim = claim;
      });
    } catch (error) {
      const { claim } = attempt;
      report(error, { workerId: options.workerId, ...(claim === null ? {} : { runId: claim.runId }) }, claim);
      return 'idle';
    }
  };

  const onWake = (): void => {
    if (interruptSleep === undefined) wakePending = true;
    else interruptSleep();
  };

  const sleep = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (wakePending) {
        wakePending = false;
        resolve();
        return;
      }
      const timer = setTimeout(done, idlePollMs);
      function done(): void {
        clearTimeout(timer);
        interruptSleep = undefined;
        resolve();
      }
      interruptSleep = done;
    });

  const sweepMemories = (): void => {
    const now = options.clock.now();
    for (const [runId, memory] of memories) {
      const status = options.store.getRun(runId)?.status;
      if (memory.deadlineAt <= now || status === undefined || TERMINAL_STATUSES.includes(status)) memories.delete(runId);
    }
  };

  const poll = async (): Promise<void> => {
    while (!stopping) {
      const outcome = await pollOnce();
      sweepMemories();
      if (outcome === 'idle') await sleep();
    }
  };

  return {
    runOnce: () => runOnce(),
    start: () => {
      if (loop !== undefined) return;
      stopping = false;
      unsubscribeWake = options.wake?.subscribe(onWake);
      loop = poll();
    },
    stop: async () => {
      stopping = true;
      unsubscribeWake?.();
      unsubscribeWake = undefined;
      interruptSleep?.();
      for (const control of controls) control.requestYield();
      const running = loop;
      loop = undefined;
      if (running !== undefined) await running;
      await Promise.allSettled([...inFlight]);
    },
    memorySize: () => memories.size,
    abort: async () => {
      aborted = true;
      stopping = true;
      unsubscribeWake?.();
      unsubscribeWake = undefined;
      interruptSleep?.();
      for (const control of controls) control.shutdown();
      const running = loop;
      loop = undefined;
      if (running !== undefined) await running;
      await Promise.allSettled([...inFlight]);
    },
  };
};
