import { Agent, request } from 'undici';
import { createUdsClient } from '@momonga/foundation';

export type UpstreamEndpoint = { kind: 'unix'; socketPath: string } | { kind: 'tcp'; baseUrl: string };

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
};

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

const unixClient = (socketPath: string, route: EndpointRoute): EndpointClient => {
  const client = createUdsClient(socketPath, { headersTimeoutMs: 0, bodyTimeoutMs: 0 });
  return {
    post: (options) => client.request({ method: 'POST', path: route.unixPath, ...options }),
    close: () => client.close(),
  };
};

const tcpClient = (baseUrl: string, route: EndpointRoute): EndpointClient => {
  const base = new URL(baseUrl);
  const url = new URL(`${base.pathname.replace(/\/+$/, '')}${route.urlSuffix}`, base.origin);
  const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  let closing: Promise<void> | undefined;
  return {
    post: async (options) => {
      const response = await request(url, {
        dispatcher: agent,
        method: 'POST',
        headers: options.headers,
        body: options.body,
        signal: options.signal,
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

export const createEndpointPool = (route: EndpointRoute): EndpointPool => {
  const clients = new Map<string, EndpointClient>();
  let closed = false;
  return {
    clientFor: (endpoint) => {
      if (closed) throw new Error(`the ${route.label} adapter is closed`);
      const key = keyOf(endpoint);
      let client = clients.get(key);
      if (client === undefined) {
        client = endpoint.kind === 'unix' ? unixClient(endpoint.socketPath, route) : tcpClient(endpoint.baseUrl, route);
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
