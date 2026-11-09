import { request } from 'undici';
import { createOutboundDispatcher, createUdsClient } from '@momonga/foundation';
import type { OutboundNetwork } from '@momonga/foundation';
import type { GatewayTimers } from '../../types.ts';

export type UpstreamEndpoint = { kind: 'unix'; socketPath: string } | { kind: 'tcp'; baseUrl: string; network: OutboundNetwork };

export type KeyedEndpoint = { kind: 'unix'; socketPath: string } | { kind: 'tcp'; baseUrl: string };

export const reachableEndpoint = (endpoint: KeyedEndpoint, network: OutboundNetwork): UpstreamEndpoint =>
  endpoint.kind === 'unix' ? endpoint : { kind: 'tcp', baseUrl: endpoint.baseUrl, network };

export type UpstreamLiveness = { headersTimeoutMs: number; idleTimeoutMs: number; timers?: GatewayTimers };

export type EndpointRoute = { label: string; unixPath: string; urlSuffix: string };

export type CompletionResponse = {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
};

export type CompletionPost = {
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  subpath?: string;
  streamed?: true;
};

const STREAMED_BODY_TIMEOUT_MS = 0;

type EndpointClient = {
  post(options: CompletionPost): Promise<CompletionResponse>;
  close(): Promise<void>;
};

const lowercased = (headers: Record<string, string | string[] | undefined>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
};

const unixClient = (socketPath: string, route: EndpointRoute, liveness: UpstreamLiveness): EndpointClient => {
  const client = createUdsClient(socketPath, { headersTimeoutMs: liveness.headersTimeoutMs, bodyTimeoutMs: liveness.idleTimeoutMs });
  return {
    post: ({ subpath, streamed, ...options }) =>
      client.request({ method: 'POST', path: `${route.unixPath}${subpath ?? ''}`, ...options, ...(streamed === undefined ? {} : { bodyTimeoutMs: STREAMED_BODY_TIMEOUT_MS }) }),
    close: () => client.close(),
  };
};

const tcpClient = (endpoint: Extract<UpstreamEndpoint, { kind: 'tcp' }>, route: EndpointRoute, liveness: UpstreamLiveness): EndpointClient => {
  const base = new URL(endpoint.baseUrl);
  const urlFor = (subpath: string | undefined): URL => new URL(`${base.pathname.replace(/\/+$/, '')}${route.urlSuffix}${subpath ?? ''}`, base.origin);
  const agent = createOutboundDispatcher(endpoint.network, {
    connectReplyTimeoutMs: liveness.headersTimeoutMs,
    headersTimeout: liveness.headersTimeoutMs,
    bodyTimeout: liveness.idleTimeoutMs,
  });
  let closing: Promise<void> | undefined;
  return {
    post: async (options) => {
      const response = await request(urlFor(options.subpath), {
        dispatcher: agent,
        method: 'POST',
        headers: options.headers,
        body: options.body,
        signal: options.signal,
        ...(options.streamed === undefined ? {} : { bodyTimeout: STREAMED_BODY_TIMEOUT_MS }),
      });
      return { status: response.statusCode, headers: lowercased(response.headers), body: response.body };
    },
    close: () => {
      closing ??= agent.close();
      return closing;
    },
  };
};

const keyOf = (endpoint: UpstreamEndpoint): string =>
  endpoint.kind === 'unix' ? `unix:${endpoint.socketPath}` : `tcp:${endpoint.baseUrl}`;

export type EndpointPool = {
  clientFor(endpoint: UpstreamEndpoint): { post(options: CompletionPost): Promise<CompletionResponse> };
  close(): Promise<void>;
};

export const createEndpointPool = (route: EndpointRoute, liveness: UpstreamLiveness): EndpointPool => {
  const clients = new Map<string, EndpointClient>();
  let closed = false;
  return {
    clientFor: (endpoint) => {
      if (closed) throw new Error(`the ${route.label} adapter is closed`);
      const key = keyOf(endpoint);
      let client = clients.get(key);
      if (client === undefined) {
        client = endpoint.kind === 'unix' ? unixClient(endpoint.socketPath, route, liveness) : tcpClient(endpoint, route, liveness);
        clients.set(key, client);
      }
      return client;
    },
    close: async () => {
      closed = true;
      const open = [...clients.values()];
      clients.clear();
      await Promise.all(open.map((client) => client.close()));
    },
  };
};
