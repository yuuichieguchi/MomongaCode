import { Agent, request } from 'undici';
import { createUdsClient } from '@momonga/foundation';
import { CHAT_COMPLETIONS_PATH, CHAT_COMPLETIONS_SUFFIX } from './limits.ts';
import type { ChatCompletionsEndpoint } from './types.ts';

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

const unixClient = (socketPath: string): EndpointClient => {
  const client = createUdsClient(socketPath, { headersTimeoutMs: 0, bodyTimeoutMs: 0 });
  return {
    post: (options) => client.request({ method: 'POST', path: CHAT_COMPLETIONS_PATH, ...options }),
    close: () => client.close(),
  };
};

const tcpClient = (baseUrl: string): EndpointClient => {
  const base = new URL(baseUrl);
  const url = new URL(`${base.pathname.replace(/\/+$/, '')}${CHAT_COMPLETIONS_SUFFIX}`, base.origin);
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

const keyOf = (endpoint: ChatCompletionsEndpoint): string =>
  endpoint.kind === 'unix' ? `unix:${endpoint.socketPath}` : `tcp:${endpoint.baseUrl}`;

export type EndpointPool = {
  clientFor(endpoint: ChatCompletionsEndpoint): { post(options: CompletionPost): Promise<CompletionResponse> };
  close(): Promise<void>;
};

export const createEndpointPool = (): EndpointPool => {
  const clients = new Map<string, EndpointClient>();
  let closed = false;
  return {
    clientFor: (endpoint) => {
      if (closed) throw new Error('the chat-completions adapter is closed');
      const key = keyOf(endpoint);
      let client = clients.get(key);
      if (client === undefined) {
        client = endpoint.kind === 'unix' ? unixClient(endpoint.socketPath) : tcpClient(endpoint.baseUrl);
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
