import type { Claim } from '@momonga/store';
import { runClaim } from './claim-runner.ts';
import { describeError } from './errors.ts';
import type { Worker, WorkerErrorContext, WorkerOptions } from './types.ts';

const DEFAULT_IDLE_POLL_MS = 250;

export const createWorker = (options: WorkerOptions): Worker => {
  const idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
  let stopping = false;
  let loop: Promise<void> | undefined;
  let interruptSleep: (() => void) | undefined;
  let wakePending = false;
  let unsubscribeWake: (() => void) | undefined;

  const noticeOnClaim = (message: string, claim: Claim): void => {
    try {
      options.store.append(claim, [{ type: 'notice', level: 'error', message }]);
    } catch {
      return;
    }
  };

  const report = (error: unknown, context: WorkerErrorContext, claim: Claim | null): void => {
    const failure = `The worker failed on this run: ${describeError(error)}`;
    if (options.onError === undefined) {
      if (claim !== null) noticeOnClaim(failure, claim);
      return;
    }
    try {
      options.onError(error, context);
    } catch (hookError) {
      if (claim !== null) noticeOnClaim(`${failure} (the error hook also failed: ${describeError(hookError)})`, claim);
    }
  };

  const runOnce = async (onClaim?: (claim: Claim) => void): Promise<'idle' | 'yielded'> => {
    const claim = options.store.claim(options.workerId);
    if (claim === null) return 'idle';
    onClaim?.(claim);
    await runClaim(options, claim);
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

  const poll = async (): Promise<void> => {
    while (!stopping) {
      if ((await pollOnce()) === 'idle') await sleep();
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
      const running = loop;
      loop = undefined;
      if (running !== undefined) await running;
    },
  };
};
