import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FetchLike, JSONRPCMessage, OAuthClientProvider, Transport, TransportSendOptions } from '@modelcontextprotocol/client';
import type { McpRemoteServerConfig, McpServerScope } from '@momonga/config';
import { SSE_RECONNECT_BASE_MS, SSE_RECONNECT_MAX_MS } from '@momonga/foundation';
import { assertRemoteUrl } from './remote-policy.ts';
import { createTaskHandleRewriter } from './task-handle.ts';
import type { McpTimers } from './timers.ts';
import type { StdioTransportExit } from './stdio-transport.ts';

export const RECONNECT_BASE_MS = SSE_RECONNECT_BASE_MS;
export const RECONNECT_MAX_MS = SSE_RECONNECT_MAX_MS;
export const RECONNECT_GROWTH = 2;
export const STREAM_RESUME_ATTEMPTS = 2;

export interface ConnectionTransport extends Transport {
  readonly pgid: number | undefined;
  diagnostics(): { stderrTail: string; exit: StdioTransportExit | null };
  terminateSession(): Promise<void>;
  toolCallsDelivered(): number;
}

export type RemoteTransportOptions = {
  config: McpRemoteServerConfig;
  scope: McpServerScope;
  fetch: FetchLike;
  authProvider: OAuthClientProvider | undefined;
  timers: McpTimers;
};

class RemoteTransport implements ConnectionTransport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  private handler: Transport['onmessage'];
  private readonly taskHandles = createTaskHandleRewriter();
  private delivered = 0;
  private readonly inner: StreamableHTTPClientTransport;

  constructor(inner: StreamableHTTPClientTransport) {
    this.inner = inner;
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
  }

  get onmessage(): Transport['onmessage'] {
    return this.handler;
  }

  set onmessage(handler: Transport['onmessage']) {
    this.handler = handler;
    this.inner.onmessage = (message) => handler?.(this.taskHandles.inbound(message));
  }

  get hasPerRequestStream(): boolean {
    return this.inner.hasPerRequestStream;
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  get pgid(): undefined {
    return undefined;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion(version);
  }

  diagnostics(): { stderrTail: string; exit: StdioTransportExit | null } {
    return { stderrTail: '', exit: null };
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.taskHandles.outbound(message);
    await this.inner.send(message, options as Parameters<StreamableHTTPClientTransport['send']>[1]);
    if ('method' in message && message.method === 'tools/call') this.delivered += 1;
  }

  async close(): Promise<void> {
    this.taskHandles.reset();
    return this.inner.close();
  }

  terminateSession(): Promise<void> {
    return this.inner.terminateSession();
  }

  toolCallsDelivered(): number {
    return this.delivered;
  }
}

export const createRemoteTransport = ({ config, scope, fetch, authProvider, timers }: RemoteTransportOptions): ConnectionTransport => {
  const url = assertRemoteUrl(config.url, scope);
  const inner = new StreamableHTTPClientTransport(url, {
    fetch,
    redirectPolicy: 'same-origin',
    ...(authProvider === undefined ? {} : { authProvider }),
    ...(config.headers === undefined ? {} : { requestInit: { headers: config.headers } }),
    reconnectionOptions: {
      initialReconnectionDelay: RECONNECT_BASE_MS,
      maxReconnectionDelay: RECONNECT_MAX_MS,
      reconnectionDelayGrowFactor: RECONNECT_GROWTH,
      maxRetries: STREAM_RESUME_ATTEMPTS,
    },
    reconnectionScheduler: (reconnect, delay) => {
      const handle = timers.setTimeout(reconnect, delay);
      return () => timers.clearTimeout(handle);
    },
  });
  return new RemoteTransport(inner);
};
