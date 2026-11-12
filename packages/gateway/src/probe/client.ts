import { request } from 'undici';
import { OperationLimitError, createOutboundDispatcher, createUdsClient, fixedSocket, operationLimit } from '@momonga/foundation';
import type { Clock, OutboundNetwork, Timing, UdsClient, UdsResponse } from '@momonga/foundation';
import { readTextLimited } from '../adapters/shared/body-reading.ts';
import type { RequestGate } from './request-gate.ts';

export interface HttpResult {
  status: number;
  text: string;
  headers: Record<string, string>;
}

export type ProbeTimers = Timing;

export type MeasurementProgress = { step(name: string, boundMs: number): void };

export type ProbeHostPorts = { readonly clock: Clock; readonly timers: ProbeTimers };

export type ProbePorts = ProbeHostPorts & { readonly gate: RequestGate };

export const PROBE_STEP_SPEED_MULTIPLE = 8;

export const PROBE_STEP_FLOOR_MS = 5_000;

export type StepBound = { readonly capMs: number; currentMs(requestBytes: number): number; observe(elapsedMs: number, requestBytes: number): void };

export const fixedStepBound = (capMs: number): StepBound => ({ capMs, currentMs: () => capMs, observe: () => undefined });

export const speedStepBound = (capMs: number): StepBound => {
  let loaded = false;
  let slowestMs = 0;
  let slowestMsPerByte = 0;
  return {
    capMs,
    currentMs: (requestBytes) => {
      if (slowestMs === 0) return capMs;
      return Math.min(capMs, Math.max(PROBE_STEP_FLOOR_MS, Math.ceil(PROBE_STEP_SPEED_MULTIPLE * Math.max(slowestMs, slowestMsPerByte * requestBytes))));
    },
    observe: (elapsedMs, requestBytes) => {
      if (!loaded) {
        loaded = true;
        return;
      }
      slowestMs = Math.max(slowestMs, elapsedMs, 1);
      slowestMsPerByte = Math.max(slowestMsPerByte, elapsedMs / Math.max(requestBytes, 1));
    },
  };
};

export type ProbeEndpoint =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'tcp'; baseUrl: string; network: OutboundNetwork; headers?: Record<string, string> };

export type ProbeRoute = 'health' | 'models' | 'chat';

export type ManagedProbeRoutes = { readonly readyPath: string; readonly listPath: string; readonly idPath: readonly string[] };

export interface ProbeClient {
  readonly hasHealthRoute: boolean;
  get(route: 'health' | 'models'): Promise<HttpResult>;
  post(route: 'chat', body: unknown): Promise<HttpResult>;
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpResult>;
  stream(route: 'chat', body: unknown): Promise<{ status: number; chunks: AsyncIterable<Uint8Array> }>;
  close(): Promise<void>;
}

const UNIX_PATHS: Record<ProbeRoute, string> = { health: '/health', models: '/v1/models', chat: '/v1/chat/completions' };

const tcpPathsOf = (baseUrl: string): Record<ProbeRoute, string> => {
  const prefix = new URL(baseUrl).pathname.replace(/\/+$/, '');
  return { health: `${prefix}/health`, models: `${prefix}/models`, chat: `${prefix}/chat/completions` };
};

const transportOf = (endpoint: ProbeEndpoint, connectTimeoutMs: number): { uds: UdsClient; paths: Record<ProbeRoute, string>; headers: Record<string, string> } => {
  if (endpoint.kind === 'unix') return { uds: createUdsClient(fixedSocket(endpoint.socketPath), { connectTimeoutMs }), paths: UNIX_PATHS, headers: {} };
  return { uds: createTcpClient(new URL(endpoint.baseUrl).origin, endpoint.network, connectTimeoutMs), paths: tcpPathsOf(endpoint.baseUrl), headers: endpoint.headers ?? {} };
};

const createTcpClient = (origin: string, network: OutboundNetwork, connectTimeoutMs: number): UdsClient => {
  const agent = createOutboundDispatcher(network, { connectReplyTimeoutMs: connectTimeoutMs });
  return {
    request: async (options) => {
      const response = await request(`${origin}${options.path}`, {
        dispatcher: agent,
        method: options.method as 'GET',
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      return { status: response.statusCode, headers, body: response.body, text: () => response.body.text(), json: () => response.body.json() };
    },
    close: () => agent.close(),
    destroy: () => agent.destroy().then(() => undefined),
  };
};

export class ProbeTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(method: string, path: string, timeoutMs: number) {
    super(`Probe request ${method} ${path} timed out after ${timeoutMs} ms`);
    this.name = 'ProbeTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export const PROBE_REPLY_MAX_BYTES = 8 * 1024 * 1024;

export class ProbeReplyTooLargeError extends Error {
  constructor(method: string, path: string) {
    super(`the reply to ${method} ${path} exceeds ${PROBE_REPLY_MAX_BYTES} bytes`);
    this.name = 'ProbeReplyTooLargeError';
  }
}

export const readProbeReply = async (method: string, path: string, response: UdsResponse): Promise<string> => {
  const read = await readTextLimited(response.body, PROBE_REPLY_MAX_BYTES);
  if (read.truncated) throw new ProbeReplyTooLargeError(method, path);
  return read.text;
};

export type ProbeClientOptions = {
  signal: AbortSignal | undefined;
  bound: StepBound;
  timers: ProbeTimers;
  gate: RequestGate;
  routes?: ManagedProbeRoutes;
  onSend?: (body: unknown) => void;
};

export class MeasurementYieldedError extends Error {
  constructor() {
    super('the measurement request gave way to a request of the person');
    this.name = 'MeasurementYieldedError';
  }
}

export const createProbeClient = (endpoint: ProbeEndpoint, options: ProbeClientOptions): ProbeClient => {
  const { signal, bound, timers, gate } = options;
  const managedRoutes = options.routes;
  const transport = transportOf(endpoint, bound.capMs);
  const { uds, headers: authHeaders } = transport;
  const paths: Record<ProbeRoute, string> = managedRoutes === undefined ? transport.paths : { ...transport.paths, health: managedRoutes.readyPath, models: managedRoutes.listPath };
  const hasHealthRoute = managedRoutes !== undefined;
  const parent = signal ?? new AbortController().signal;

  const onceWithin = async <T>(
    method: string,
    path: string,
    requestBytes: number,
    perform: (requestSignal: AbortSignal, timedOut: () => boolean, dispose: () => void) => Promise<T>,
    streaming: boolean,
    body: unknown,
  ): Promise<T> => {
    const turn = await gate.turn(parent);
    if (method === 'POST') {
      try {
        options.onSend?.(body);
      } catch (error) {
        turn.end();
        throw error;
      }
    }
    const limitMs = bound.currentMs(requestBytes);
    const limit = operationLimit(AbortSignal.any([parent, turn.yielded]), limitMs, `the step bound of ${method} ${path}`, timers);
    const timedOut = (): boolean => limit.signal.reason instanceof OperationLimitError;
    const startedMs = timers.monotonicMs();
    const release = (): void => {
      limit.dispose();
      turn.end();
    };
    try {
      const done = await perform(limit.signal, timedOut, release);
      if (!streaming && method === 'POST') bound.observe(timers.monotonicMs() - startedMs, requestBytes);
      return done;
    } catch (error) {
      release();
      if (timedOut()) throw new ProbeTimeoutError(method, path, limitMs);
      if (turn.yielded.aborted && !parent.aborted) throw new MeasurementYieldedError();
      throw error;
    } finally {
      if (!streaming) release();
    }
  };

  const withTimeout = async <T>(
    method: string,
    path: string,
    body: unknown,
    perform: (requestSignal: AbortSignal, timedOut: () => boolean, dispose: () => void) => Promise<T>,
    streaming = false,
  ): Promise<T> => {
    const requestBytes = bytesOf(body);
    for (;;) {
      try {
        return await onceWithin(method, path, requestBytes, perform, streaming, body);
      } catch (error) {
        if (!(error instanceof MeasurementYieldedError)) throw error;
      }
    }
  };

  const bytesOf = (body: unknown): number => (body === undefined ? 0 : JSON.stringify(body).length);

  const jsonPost = (path: string, body: unknown, requestSignal: AbortSignal) =>
    uds.request({
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify(body),
      signal: requestSignal,
    });

  return {
    hasHealthRoute,
    get: (route) =>
      withTimeout('GET', paths[route], undefined, async (requestSignal) => {
        const response = await uds.request({ method: 'GET', path: paths[route], headers: authHeaders, signal: requestSignal });
        return { status: response.status, text: await readProbeReply('GET', paths[route], response), headers: response.headers };
      }),
    post: (route, body) =>
      withTimeout('POST', paths[route], body, async (requestSignal) => {
        const response = await jsonPost(paths[route], body, requestSignal);
        return { status: response.status, text: await readProbeReply('POST', paths[route], response), headers: response.headers };
      }),
    request: (method, path, body) =>
      withTimeout(method, path, body, async (requestSignal) => {
        const response =
          method === 'GET'
            ? await uds.request({ method, path, headers: authHeaders, signal: requestSignal })
            : await jsonPost(path, body, requestSignal);
        return { status: response.status, text: await readProbeReply(method, path, response), headers: response.headers };
      }),
    stream: (route, body) => {
      const path = paths[route];
      return withTimeout(
        'POST',
        path,
        body,
        async (requestSignal, timedOut, dispose) => {
          const response = await jsonPost(path, body, requestSignal);
          async function* chunks(): AsyncGenerator<Uint8Array> {
            try {
              yield* response.body;
            } catch (error) {
              if (timedOut()) throw new ProbeTimeoutError('POST', path, bound.currentMs(bytesOf(body)));
              throw error;
            } finally {
              dispose();
            }
          }
          return { status: response.status, chunks: chunks() };
        },
        true,
      );
    },
    close: () => uds.close(),
  };
};
