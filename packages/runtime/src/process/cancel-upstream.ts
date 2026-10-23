import type { RuntimeStore } from '@momonga/store';
import { foldRunState, initialRunState } from '@momonga/store';
import type { GatewayClient } from '../gateway-client.ts';
import { modelKey } from '../model-key.ts';
import type { ServiceTimers } from '../service/timers.ts';

export type CancelUpstreamTracker = {
  cancel(runId: string): Promise<void>;
  settle(ms: number): Promise<void>;
};

export type CancelUpstreamOptions = {
  store: Pick<RuntimeStore, 'getRun' | 'load'>;
  gatewayClient: Pick<GatewayClient, 'cancel'>;
  timers: ServiceTimers;
};

export const createCancelUpstream = ({ store, gatewayClient, timers }: CancelUpstreamOptions): CancelUpstreamTracker => {
  const controller = new AbortController();
  const calls = new Set<Promise<void>>();

  const cancelInFlight = async (runId: string): Promise<void> => {
    const run = store.getRun(runId);
    if (run === undefined) return;
    const { snapshot, tail } = store.load(runId);
    const state = tail.reduce(foldRunState, snapshot?.state ?? initialRunState({ runId, sessionId: run.sessionId }));
    const inFlight = state.inFlightModelRequest;
    if (inFlight === undefined) return;
    await gatewayClient.cancel(modelKey(runId, inFlight.step, inFlight.attempt), { signal: controller.signal });
  };

  return {
    cancel: (runId) => {
      const call = cancelInFlight(runId);
      const tracked = call.then(
        () => undefined,
        () => undefined,
      );
      const entry = tracked.finally(() => void calls.delete(entry));
      calls.add(entry);
      return call;
    },
    settle: async (ms) => {
      let handle: unknown;
      const expired = new Promise<void>((resolve) => {
        handle = timers.setTimeout(resolve, ms);
      });
      try {
        await Promise.race([Promise.allSettled([...calls]), expired]);
      } finally {
        timers.clearTimeout(handle);
        controller.abort();
      }
    },
  };
};
