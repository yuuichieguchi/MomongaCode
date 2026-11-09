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

const abortionOf = (signal: AbortSignal): { aborted: Promise<never>; dispose(): void } => {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    aborted,
    dispose: () => {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    },
  };
};

export const createCancelUpstream = ({ store, gatewayClient, timers }: CancelUpstreamOptions): CancelUpstreamTracker => {
  const controller = new AbortController();
  const calls = new Set<Promise<void>>();

  const cancelInFlight = async (runId: string, caller: AbortSignal | undefined): Promise<void> => {
    const run = store.getRun(runId);
    if (run === undefined) return;
    const inFlight = await store.inFlightModelRequestOf(runId);
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
      if (signal === undefined) return call;
      const abortion = abortionOf(signal);
      return Promise.race([call, abortion.aborted]).finally(abortion.dispose);
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
