import { Client, TRACEPARENT_META_KEY, TRACESTATE_META_KEY } from '@modelcontextprotocol/client';
import type { CallToolResult, Implementation, ProtocolEra, Tool } from '@modelcontextprotocol/client';
import type { McpServerConfig, McpStdioServerConfig } from '@momonga/config';
import { CircuitBreaker, computeBackoff } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { createSafeSchemaValidator } from './schema-validator.ts';
import { createStdioTransport } from './stdio-transport.ts';
import type { McpMarkerOptions, StdioTransport } from './stdio-transport.ts';

const CLIENT_NAME = 'momonga';
const CLIENT_VERSION = '0.0.0';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_RESET_AFTER_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 200;
const BACKOFF_MAX_MS = 5000;

export type McpServerState = 'idle' | 'connected' | 'disconnected' | 'unavailable' | 'closed';

export type McpServerDiagnostics = {
  server: string;
  state: McpServerState;
  pgid: number | undefined;
  protocolVersion: string | undefined;
  lastError: string | null;
  stderrTail: string;
};

export type McpCallToolInput = {
  name: string;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  traceparent?: string;
  tracestate?: string;
};

export interface McpServerConnection {
  readonly name: string;
  readonly protocolVersion: string | undefined;
  readonly protocolEra: ProtocolEra | undefined;
  readonly serverInfo: Implementation | undefined;
  readonly instructions: string | undefined;
  listTools(options?: { signal?: AbortSignal }): Promise<Tool[]>;
  callTool(input: McpCallToolInput): Promise<CallToolResult>;
  diagnostics(): McpServerDiagnostics;
  close(): Promise<void>;
}

export type McpConnectionOptions = {
  name: string;
  config: McpServerConfig;
  projectDir: string;
  baseEnv: Record<string, string>;
  clock: Clock;
  random?: () => number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  resetAfterMs?: number;
  markers?: McpMarkerOptions;
  closeGraceMs?: number;
};

export class McpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpUnavailableError';
  }
}

type Session = { client: Client; transport: StdioTransport };

const describeExit = (transport: StdioTransport): string | undefined => {
  const { exit } = transport.diagnostics();
  if (exit === null) return undefined;
  return exit.signal === null ? `server exited with code ${exit.code}` : `server exited with signal ${exit.signal}`;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

const assertStdio = (name: string, config: McpServerConfig): McpStdioServerConfig => {
  if ('command' in config) return config;
  throw new Error(`MCP server "${name}" uses the ${config.type} transport; remote MCP servers are not supported yet`);
};

class ManagedConnection implements McpServerConnection {
  readonly name: string;

  private readonly options: McpConnectionOptions;
  private readonly breaker: CircuitBreaker;
  private readonly random: () => number;
  private session: Session | undefined;
  private lastTransport: StdioTransport | undefined;
  private connecting: Promise<Session> | undefined;
  private state: McpServerState = 'idle';
  private lastError: string | null = null;
  private lastProtocolVersion: string | undefined;
  private lastProtocolEra: ProtocolEra | undefined;
  private lastServerInfo: Implementation | undefined;
  private lastInstructions: string | undefined;
  private consecutiveFailures = 0;
  private closing: Promise<void> | undefined;
  private pendingTransport: StdioTransport | undefined;
  private readonly lifetime = new AbortController();

  constructor(options: McpConnectionOptions) {
    this.options = options;
    this.name = options.name;
    this.random = options.random ?? Math.random;
    this.breaker = new CircuitBreaker({
      failureThreshold: FAILURE_THRESHOLD,
      openMs: options.resetAfterMs ?? DEFAULT_RESET_AFTER_MS,
      clock: options.clock,
    });
  }

  get protocolVersion(): string | undefined {
    return this.session?.client.getNegotiatedProtocolVersion() ?? this.lastProtocolVersion;
  }

  get protocolEra(): ProtocolEra | undefined {
    return this.session?.client.getProtocolEra() ?? this.lastProtocolEra;
  }

  get serverInfo(): Implementation | undefined {
    return this.session?.client.getServerVersion() ?? this.lastServerInfo;
  }

  get instructions(): string | undefined {
    return this.session?.client.getInstructions() ?? this.lastInstructions;
  }

  diagnostics(): McpServerDiagnostics {
    const transport = this.session?.transport ?? this.lastTransport;
    return {
      server: this.name,
      state: this.state,
      pgid: this.session?.transport.pgid,
      protocolVersion: this.protocolVersion,
      lastError: this.lastError,
      stderrTail: transport?.diagnostics().stderrTail ?? '',
    };
  }

  async connect(): Promise<void> {
    await this.ensureSession();
  }

  async listTools(options?: { signal?: AbortSignal }): Promise<Tool[]> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const { client, transport } = await this.ensureSessionUnless(signal);
    try {
      return (await client.listTools(undefined, signal === undefined ? undefined : { signal })).tools;
    } catch (error) {
      throw this.withExitDetail(transport, error);
    }
  }

  async callTool(input: McpCallToolInput): Promise<CallToolResult> {
    const { client, transport } = await this.ensureSession();
    const meta: Record<string, string> = {};
    if (input.traceparent !== undefined) meta[TRACEPARENT_META_KEY] = input.traceparent;
    if (input.tracestate !== undefined) meta[TRACESTATE_META_KEY] = input.tracestate;
    try {
      return await client.callTool(
        { name: input.name, arguments: input.arguments, ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }) },
        {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          timeout: input.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        },
      );
    } catch (error) {
      throw this.withExitDetail(transport, error);
    }
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.lifetime.abort();
    await this.pendingTransport?.close();
    await this.connecting?.catch(() => undefined);
    this.state = 'closed';
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) await session.client.close();
  }

  private withExitDetail(transport: StdioTransport, error: unknown): Error {
    const detail = describeExit(transport);
    if (detail === undefined) return error instanceof Error ? error : new Error(String(error));
    this.lastError = detail;
    return new Error(`${errorMessage(error)} (${detail})`);
  }

  private async ensureSessionUnless(signal: AbortSignal | undefined): Promise<Session> {
    const pending = this.ensureSession();
    if (signal === undefined) return pending;
    pending.catch(() => undefined);
    return new Promise<Session>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (session) => {
          signal.removeEventListener('abort', onAbort);
          resolve(session);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private async ensureSession(): Promise<Session> {
    if (this.closing !== undefined) throw new Error(`MCP server "${this.name}" connection is closed`);
    if (this.session !== undefined) return this.session;
    this.connecting ??= this.openSession().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openSession(): Promise<Session> {
    const config = this.stdioConfig();
    if (!this.breaker.canPass()) {
      this.state = 'unavailable';
      throw new McpUnavailableError(`MCP server "${this.name}" is unavailable: ${this.lastError ?? 'unknown error'}`);
    }
    if (this.consecutiveFailures > 0) {
      const delay = computeBackoff({
        attempt: this.consecutiveFailures - 1,
        baseMs: BACKOFF_BASE_MS,
        maxMs: BACKOFF_MAX_MS,
        random: this.random,
      });
      if (delay > 0) await sleep(delay, this.lifetime.signal);
    }
    this.assertOpen();
    const { projectDir, baseEnv, connectTimeoutMs } = this.options;
    const { markers, closeGraceMs } = this.options;
    const transport = createStdioTransport({
      name: this.name,
      config,
      projectDir,
      baseEnv,
      ...(markers === undefined ? {} : { markers }),
      ...(closeGraceMs === undefined ? {} : { closeGraceMs }),
    });
    this.lastTransport = transport;
    this.pendingTransport = transport;
    const client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto' },
        jsonSchemaValidator: createSafeSchemaValidator(),
        listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => undefined } },
      },
    );
    client.onerror = (error) => {
      this.lastError = error.message;
    };
    client.onclose = () => this.handleClose(client, transport);
    try {
      await client.connect(transport, { timeout: connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, signal: this.lifetime.signal });
    } catch (error) {
      this.pendingTransport = undefined;
      if (this.lifetime.signal.aborted) {
        await client.close();
        throw error instanceof Error ? error : new Error(String(error));
      }
      const failure = this.withExitDetail(transport, error);
      this.lastError = failure.message;
      await client.close();
      this.consecutiveFailures += 1;
      this.breaker.onFailure();
      this.state = this.breaker.state === 'open' ? 'unavailable' : 'disconnected';
      throw failure;
    }
    this.pendingTransport = undefined;
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.breaker.onSuccess();
    const session: Session = { client, transport };
    this.session = session;
    this.lastProtocolVersion = client.getNegotiatedProtocolVersion();
    this.lastProtocolEra = client.getProtocolEra();
    this.lastServerInfo = client.getServerVersion();
    this.lastInstructions = client.getInstructions();
    this.state = 'connected';
    return session;
  }

  private assertOpen(): void {
    if (this.lifetime.signal.aborted) throw new Error(`MCP server "${this.name}" connection is closed`);
  }

  private stdioConfig(): McpStdioServerConfig {
    try {
      return assertStdio(this.name, this.options.config);
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
  }

  private handleClose(client: Client, transport: StdioTransport): void {
    if (this.session?.client !== client) return;
    this.session = undefined;
    if (this.closing !== undefined) return;
    this.state = 'disconnected';
    this.lastError = describeExit(transport) ?? this.lastError ?? 'connection closed';
  }
}

export const createManagedConnection = (options: McpConnectionOptions): ManagedConnection => new ManagedConnection(options);

export type ConnectMcpServerOptions = McpConnectionOptions;

export const connectMcpServer = async (options: ConnectMcpServerOptions): Promise<McpServerConnection> => {
  const connection = createManagedConnection(options);
  await connection.connect();
  return connection;
};
