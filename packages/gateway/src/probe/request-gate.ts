import type { ProviderAdapter } from '@momonga/protocol';

export type MeasurementTurn = { readonly yielded: AbortSignal; end(): void };

export type RequestGate = {
  person(): () => void;
  turn(signal: AbortSignal): Promise<MeasurementTurn>;
};

export const createRequestGate = (): RequestGate => {
  let inFlight = 0;
  const turns = new Set<AbortController>();
  const waiting = new Set<() => void>();

  const reopen = (): void => {
    if (inFlight > 0) return;
    for (const wake of [...waiting]) wake();
  };

  return {
    person: () => {
      inFlight += 1;
      for (const turn of turns) turn.abort(new Error('a request of the person arrived at the server'));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
        reopen();
      };
    },
    turn: (signal) =>
      new Promise<MeasurementTurn>((resolve, reject) => {
        const give = (): void => {
          waiting.delete(give);
          signal.removeEventListener('abort', onAbort);
          const turn = new AbortController();
          turns.add(turn);
          resolve({ yielded: turn.signal, end: () => turns.delete(turn) });
        };
        const onAbort = (): void => {
          waiting.delete(give);
          reject(signal.reason);
        };
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        if (inFlight === 0) {
          give();
          return;
        }
        waiting.add(give);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
  };
};

export const PERSON_TRAFFIC: RequestGate = {
  person: () => () => undefined,
  turn: async () => ({ yielded: new AbortController().signal, end: () => undefined }),
};

export type RequestGates = { of(server: string): RequestGate };

export const createRequestGates = (): RequestGates => {
  const gates = new Map<string, RequestGate>();
  return {
    of: (server) => {
      const known = gates.get(server);
      if (known !== undefined) return known;
      const made = createRequestGate();
      gates.set(server, made);
      return made;
    },
  };
};

export const personGatedAdapter = (adapter: ProviderAdapter, gate: RequestGate): ProviderAdapter => {
  const { compact } = adapter;
  return {
    ...adapter,
    capabilities: (target) => adapter.capabilities(target),
    create: async function* (request, ctx) {
      const release = gate.person();
      try {
        yield* adapter.create(request, ctx);
      } finally {
        release();
      }
    },
    ...(compact === undefined
      ? {}
      : {
          compact: async (request, ctx) => {
            const release = gate.person();
            try {
              return await compact.call(adapter, request, ctx);
            } finally {
              release();
            }
          },
        }),
  };
};
