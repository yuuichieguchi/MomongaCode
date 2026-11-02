import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FetchLike, JSONRPCMessage, OAuthClientProvider, Transport, TransportSendOptions } from '@modelcontextprotocol/client';
import type { McpRemoteServerConfig, McpServerScope } from '@momonga/config';
import { assertRemoteUrl } from './remote-policy.ts';
import type { McpTimers } from './timers.ts';
import type { StdioTransportExit } from './stdio-transport.ts';

export const TASK_HANDLE_ERROR_CODE = -39001;
export const RECONNECT_BASE_MS = 200;
export const RECONNECT_MAX_MS = 5000;
export const RECONNECT_GROWTH = 2;
export const STREAM_RESUME_ATTEMPTS = 2;

export interface ConnectionTransport extends Transport {
  readonly pgid: number | undefined;
  diagnostics(): { stderrTail: string; exit: StdioTransportExit | null };
  terminateSession(): Promise<void>;
}

export type RemoteTransportOptions = {
  config: McpRemoteServerConfig;
  scope: McpServerScope;
  fetch: FetchLike;
  authProvider: OAuthClientProvider | undefined;
  timers: McpTimers;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

class RemoteTransport implements ConnectionTransport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  private handler: Transport['onmessage'];
  private readonly toolCalls = new Set<string | number>();
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
    this.inner.onmessage = (message) => handler?.(this.rewrite(message));
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

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if ('method' in message && 'id' in message && message.method === 'tools/call') this.toolCalls.add(message.id);
    return this.inner.send(message, options as Parameters<StreamableHTTPClientTransport['send']>[1]);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  terminateSession(): Promise<void> {
    return this.inner.terminateSession();
  }

  private rewrite(message: JSONRPCMessage): JSONRPCMessage {
    if (!('id' in message) || message.id === undefined) return message;
    const wasToolCall = this.toolCalls.delete(message.id);
    if (!wasToolCall || !('result' in message)) return message;
    const result: unknown = message.result;
    if (!isRecord(result) || result['resultType'] !== 'task') return message;
    return { jsonrpc: '2.0', id: message.id, error: { code: TASK_HANDLE_ERROR_CODE, message: 'the server returned a task handle', data: result } };
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
