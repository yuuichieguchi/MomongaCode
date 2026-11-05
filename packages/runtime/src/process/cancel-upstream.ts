import type { RuntimeStore } from '@momonga/store';
import type { GatewayClient } from '../gateway-client.ts';
import { modelKey } from '../model-key.ts';
import type { ServiceTimers } from '../service/timers.ts';

export type CancelUpstreamTracker = {
  cancel(runId: string, signal?: AbortSignal): Promise<void>;
  settle(ms: number): Promise<void>;
};

export type CancelUpstreamOptions = {
  store: Pick<RuntimeStore, 'getRun' | 'inFlightModelRequestOf'>;
  gatewayClient: Pick<GatewayClient, 'cancel'>;
  timers: ServiceTimers;
};

const abortionOf = (signal: AbortSignal): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

export const createCancelUpstream = ({ store, gatewayClient, timers }: CancelUpstreamOptions): CancelUpstreamTracker => {
  const controller = new AbortController();
  const calls = new Set<Promise<void>>();

  const cancelInFlight = async (runId: string, caller: AbortSignal | undefined): Promise<void> => {
    const run = store.getRun(runId);
    if (run === undefined) return;
    const inFlight = store.inFlightModelRequestOf(runId);
    if (inFlight === undefined) return;
    await gatewayClient.cancel(modelKey(runId, inFlight.step, inFlight.attempt), { signal: caller === undefined ? controller.signal : AbortSignal.any([controller.signal, caller]) });
  };

  return {
    cancel: (runId, signal) => {
      const call = cancelInFlight(runId, signal);
      const tracked = call.then(
        () => undefined,
        () => undefined,
      );
      const entry = tracked.finally(() => void calls.delete(entry));
      calls.add(entry);
      return signal === undefined ? call : Promise.race([call, abortionOf(signal)]);
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
