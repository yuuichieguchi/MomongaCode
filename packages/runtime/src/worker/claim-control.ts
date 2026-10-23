import type { Claim, RuntimeStore } from '@momonga/store';
import { LeaseLostError } from './errors.ts';

export type ClaimControl = {
  readonly signal: AbortSignal;
  lost(): never;
  leaseLost(): boolean;
  cancelRequested(): boolean;
  shuttingDown(): boolean;
  readonly shutdownRequested: Promise<void>;
  shutdown(): void;
  requestYield(): void;
  yieldRequested(): boolean;
  readonly inFlight: { modelKey?: string; compactionKey?: string };
  fail(error: unknown): void;
  recordingRaised<T>(pending: Promise<T>): Promise<T>;
  raisedDuringCancel(error: unknown): boolean;
  failure(): unknown;
  stop(): void;
};

export type ClaimControlOptions = {
  store: RuntimeStore;
  claim: Claim;
  heartbeatMs: number;
  cancelPollMs: number;
};

export const startClaimControl = ({ store, claim, heartbeatMs, cancelPollMs }: ClaimControlOptions): ClaimControl => {
  const controller = new AbortController();
  let leaseLost = false;
  let cancelRequested = false;
  let shuttingDown = false;
  let yieldRequested = false;
  const recovering = claim.status === 'CANCELLING';
  const shutdownRequested = Promise.withResolvers<void>();
  const inFlight: { modelKey?: string; compactionKey?: string } = {};
  let failure: unknown;
  const raisedAfterCancel = new Set<unknown>();

  const abortFor = (reason: 'lease_lost' | 'cancel' | 'failure' | 'shutdown'): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  const markLost = (): void => {
    leaseLost = true;
    abortFor('lease_lost');
  };

  const markCancel = (): void => {
    if (leaseLost) return;
    cancelRequested = true;
    if (!recovering) abortFor('cancel');
  };

  const shutdown = (): void => {
    shuttingDown = true;
    abortFor('shutdown');
    shutdownRequested.resolve();
  };

  const fail = (error: unknown): void => {
    failure ??= error;
    abortFor('failure');
  };

  const guarded = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      fail(error);
    }
  };

  const heartbeat = setInterval(
    () =>
      guarded(() => {
        if (leaseLost) return;
        const result = store.heartbeat(claim);
        if (result.kind === 'lease_lost') markLost();
        else if (result.cancelRequested || result.status === 'CANCELLING') markCancel();
      }),
    heartbeatMs,
  );

  const cancelPoll = setInterval(
    () =>
      guarded(() => {
        if (leaseLost) return;
        const run = store.getRun(claim.runId);
        if (run?.cancelRequested === true || run?.status === 'CANCELLING') markCancel();
      }),
    cancelPollMs,
  );

  return {
    signal: controller.signal,
    lost: () => {
      markLost();
      throw new LeaseLostError();
    },
    leaseLost: () => leaseLost,
    cancelRequested: () => cancelRequested,
    shuttingDown: () => shuttingDown,
    shutdownRequested: shutdownRequested.promise,
    shutdown,
    requestYield: () => {
      yieldRequested = true;
    },
    yieldRequested: () => yieldRequested || shuttingDown,
    inFlight,
    fail,
    recordingRaised: async (pending) => {
      try {
        return await pending;
      } catch (error) {
        if (controller.signal.reason === 'cancel') raisedAfterCancel.add(error);
        throw error;
      }
    },
    raisedDuringCancel: (error) => raisedAfterCancel.has(error),
    failure: () => failure,
    stop: () => {
      clearInterval(heartbeat);
      clearInterval(cancelPoll);
    },
  };
};
