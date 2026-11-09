import { setTimeout as setTimeoutPromise } from 'node:timers/promises';
import { request } from 'undici';
import { Deadline, createOutboundDispatcher, createUdsClient } from '@momonga/foundation';
import type { OutboundNetwork, UdsClient } from '@momonga/foundation';

export interface HttpResult {
  status: number;
  text: string;
  headers: Record<string, string>;
}

export const systemSleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  setTimeoutPromise(ms, undefined, signal === undefined ? {} : { signal });

export type ProbeEndpoint =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'tcp'; baseUrl: string; network: OutboundNetwork; headers?: Record<string, string> };

export type ProbeRoute = 'health' | 'models' | 'chat';

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

const transportOf = (endpoint: ProbeEndpoint, stepTimeoutMs: number): { uds: UdsClient; paths: Record<ProbeRoute, string>; headers: Record<string, string> } => {
  if (endpoint.kind === 'unix') return { uds: createUdsClient(endpoint.socketPath), paths: UNIX_PATHS, headers: {} };
  return { uds: createTcpClient(new URL(endpoint.baseUrl).origin, endpoint.network, stepTimeoutMs), paths: tcpPathsOf(endpoint.baseUrl), headers: endpoint.headers ?? {} };
};

const createTcpClient = (origin: string, network: OutboundNetwork, stepTimeoutMs: number): UdsClient => {
  const agent = createOutboundDispatcher(network, { connectReplyTimeoutMs: stepTimeoutMs });
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

export const createProbeClient = (
  endpoint: ProbeEndpoint,
  signal: AbortSignal | undefined,
  stepTimeoutMs: number,
  hasHealthRoute = false,
): ProbeClient => {
  const { uds, paths, headers: authHeaders } = transportOf(endpoint, stepTimeoutMs);

  const withTimeout = async <T>(
    method: string,
    path: string,
    perform: (requestSignal: AbortSignal, timedOut: () => boolean, dispose: () => void) => Promise<T>,
    streaming = false,
  ): Promise<T> => {
    const deadline = Deadline.after(stepTimeoutMs);
    const requestSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    const timedOut = (): boolean => deadline.expired && signal?.aborted !== true;
    try {
      return await perform(requestSignal, timedOut, () => deadline.dispose());
    } catch (error) {
      deadline.dispose();
      if (timedOut()) throw new ProbeTimeoutError(method, path, stepTimeoutMs);
      throw error;
    } finally {
      if (!streaming) deadline.dispose();
    }
  };

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
      withTimeout('GET', paths[route], async (requestSignal) => {
        const response = await uds.request({ method: 'GET', path: paths[route], headers: authHeaders, signal: requestSignal });
        return { status: response.status, text: await response.text(), headers: response.headers };
      }),
    post: (route, body) =>
      withTimeout('POST', paths[route], async (requestSignal) => {
        const response = await jsonPost(paths[route], body, requestSignal);
        return { status: response.status, text: await response.text(), headers: response.headers };
      }),
    request: (method, path, body) =>
      withTimeout(method, path, async (requestSignal) => {
        const response =
          method === 'GET'
            ? await uds.request({ method, path, headers: authHeaders, signal: requestSignal })
            : await jsonPost(path, body, requestSignal);
        return { status: response.status, text: await response.text(), headers: response.headers };
      }),
    stream: (route, body) => {
      const path = paths[route];
      return withTimeout(
        'POST',
        path,
        async (requestSignal, timedOut, dispose) => {
          const response = await jsonPost(path, body, requestSignal);
          async function* chunks(): AsyncGenerator<Uint8Array> {
            try {
              yield* response.body;
            } catch (error) {
              if (timedOut()) throw new ProbeTimeoutError('POST', path, stepTimeoutMs);
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
