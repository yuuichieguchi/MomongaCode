import type { StreamEvent } from '@momonga/protocol';
import { idempotencyInProgressError, invalidRequest } from './errors.ts';
import type { SharedRun } from './run.ts';
import type { GatewayServices } from './services.ts';

export type IdempotencyLookup =
  | { kind: 'miss' }
  | { kind: 'inflight'; run: SharedRun }
  | { kind: 'stored'; frames: StreamEvent[] };

export type IdempotencyRegistry = {
  lookup(key: string, digest: string, signal: AbortSignal): Promise<IdempotencyLookup>;
  begin(key: string, digest: string, run: SharedRun): void;
  end(key: string, run: SharedRun): void;
  take(key: string): SharedRun | undefined;
};

export const reusedError = (key: string) =>
  invalidRequest('idempotency_key_reused', `idempotency key "${key}" was already used with a different request body`, null, 422);

const SF_STRING = /^"((?:[^"\\]|\\["\\])*)"$/;

export const normalizeIdempotencyKey = (header: string): string => {
  const quoted = SF_STRING.exec(header);
  return quoted?.[1] === undefined ? header : quoted[1].replace(/\\(["\\])/g, '$1');
};

export const parseIdempotencyKey = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined;
  const key = normalizeIdempotencyKey(header);
  if (key === '') throw invalidRequest('invalid_idempotency_key', 'the idempotency-key header must not be empty');
  return key;
};

export const createIdempotencyRegistry = (services: GatewayServices): IdempotencyRegistry => {
  const inflight = new Map<string, { digest: string; run: SharedRun }>();
  return {
    lookup: async (key, digest, signal) => {
      const joinRunning = (): IdempotencyLookup | undefined => {
        const running = inflight.get(key);
        if (running === undefined) return undefined;
        if (running.digest !== digest) throw reusedError(key);
        if (!running.run.joinable()) throw idempotencyInProgressError(key);
        return { kind: 'inflight', run: running.run };
      };
      const runningBeforeRead = joinRunning();
      if (runningBeforeRead !== undefined) return runningBeforeRead;
      const stored = await services.store.getIdempotency(key, signal);
      const runningAfterRead = joinRunning();
      if (runningAfterRead !== undefined) return runningAfterRead;
      if (stored === undefined) return { kind: 'miss' };
      if (services.clock.now() < stored.storedAtMs + services.config.idempotency.ttlMs) {
        if (stored.digest !== digest) throw reusedError(key);
        return { kind: 'stored', frames: stored.frames };
      }
      await services.store.deleteIdempotency(key, signal);
      return joinRunning() ?? { kind: 'miss' };
    },
    begin: (key, digest, run) => {
      inflight.set(key, { digest, run });
    },
    end: (key, run) => {
      if (inflight.get(key)?.run === run) inflight.delete(key);
    },
    take: (key) => {
      const running = inflight.get(key);
      inflight.delete(key);
      return running?.run;
    },
  };
};
