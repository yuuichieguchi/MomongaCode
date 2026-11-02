import { Client, ProtocolError, TRACEPARENT_META_KEY, TRACESTATE_META_KEY } from '@modelcontextprotocol/client';
import type { CallToolResult, Implementation, ProtocolEra, Tool } from '@modelcontextprotocol/client';
import type { McpServerConfig, McpServerScope } from '@momonga/config';
import { CircuitBreaker, computeBackoff } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { authorizeMcpServer } from './authorize.ts';
import { createMcpOAuthProvider } from './oauth-provider.ts';
import type { McpOAuthProvider } from './oauth-provider.ts';
import { McpAuthorizationError, McpRemotePolicyError, isSessionExpired } from './remote-errors.ts';
import { createGuardedFetch } from './remote-policy.ts';
import type { GuardedFetch } from './remote-policy.ts';
import type { McpRemotePorts } from './remote-ports.ts';
import { TASK_HANDLE_ERROR_CODE, createRemoteTransport } from './remote-transport.ts';
import type { ConnectionTransport } from './remote-transport.ts';
import { createSafeSchemaValidator } from './schema-validator.ts';
import { createStdioTransport } from './stdio-transport.ts';
import { DEFAULT_CLOSE_GRACE_MS } from './stdio-transport.ts';
import type { McpMarkerOptions } from './stdio-transport.ts';
import { settleTask } from './tasks.ts';
import type { TaskMethod } from './tasks.ts';
import { pause, systemTimers } from './timers.ts';
import type { McpTimers } from './timers.ts';

const CLIENT_NAME = 'momonga';
const CLIENT_VERSION = '0.0.0';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_RESET_AFTER_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 200;
const BACKOFF_MAX_MS = 5000;
const MIN_SECRET_CHARS = 8;
const SECRET_HEADER = /auth|token|key|secret|cookie|password/i;
const REDACTED = '[redacted]';

export const MRTR_MAX_ROUNDS = 10;
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

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
  redact(text: string): string;
  diagnostics(): McpServerDiagnostics;
  close(): Promise<void>;
}

export type McpConnectionOptions = {
  name: string;
  config: McpServerConfig;
  scope: McpServerScope;
  projectDir: string;
  baseEnv: Record<string, string>;
  clock: Clock;
  timers?: McpTimers;
  remote?: McpRemotePorts;
  random?: () => number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  resetAfterMs?: number;
  markers?: McpMarkerOptions;
  closeGraceMs?: number;
  mrtrMaxRounds?: number;
};

export class McpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpUnavailableError';
  }
}

type Session = { client: Client; transport: ConnectionTransport; guarded: GuardedFetch | undefined };

const describeExit = (transport: ConnectionTransport): string | undefined => {
  const { exit } = transport.diagnostics();
  if (exit === null) return undefined;
  return exit.signal === null ? `server exited with code ${exit.code}` : `server exited with signal ${exit.signal}`;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isDeterministicRemoteFailure = (error: unknown): boolean => error instanceof McpRemotePolicyError || error instanceof McpAuthorizationError;

class ManagedConnection implements McpServerConnection {
  readonly name: string;

  private readonly options: McpConnectionOptions;
  private readonly breaker: CircuitBreaker;
  private readonly random: () => number;
  private readonly timers: McpTimers;
  private readonly secrets = new Set<string>();
  private session: Session | undefined;
  private lastTransport: ConnectionTransport | undefined;
  private connecting: Promise<Session> | undefined;
  private state: McpServerState = 'idle';
  private lastError: string | null = null;
  private lastProtocolVersion: string | undefined;
  private lastProtocolEra: ProtocolEra | undefined;
  private lastServerInfo: Implementation | undefined;
  private lastInstructions: string | undefined;
  private consecutiveFailures = 0;
  private closing: Promise<void> | undefined;
  private pendingTransport: ConnectionTransport | undefined;
  private readonly lifetime = new AbortController();

  constructor(options: McpConnectionOptions) {
    this.options = options;
    this.name = options.name;
    this.random = options.random ?? Math.random;
    this.timers = options.timers ?? systemTimers;
    this.breaker = new CircuitBreaker({
      failureThreshold: FAILURE_THRESHOLD,
      openMs: options.resetAfterMs ?? DEFAULT_RESET_AFTER_MS,
      clock: options.clock,
    });
    if ('headers' in options.config) {
      for (const [header, value] of Object.entries(options.config.headers ?? {})) {
        const secretive = SECRET_HEADER.test(header);
        this.trackSecret(value, secretive);
        if (secretive) for (const part of value.split(/\s+/)) this.trackSecret(part, false);
      }
    }
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

  redact(text: string): string {
    let redacted = text;
    for (const secret of this.secrets) redacted = redacted.replaceAll(secret, REDACTED);
    return redacted;
  }

  diagnostics(): McpServerDiagnostics {
    const transport = this.session?.transport ?? this.lastTransport;
    return {
      server: this.name,
      state: this.state,
      pgid: this.session?.transport.pgid,
      protocolVersion: this.protocolVersion,
      lastError: this.lastError === null ? null : this.redact(this.lastError),
      stderrTail: transport === undefined ? '' : this.redact(transport.diagnostics().stderrTail),
    };
  }

  async connect(): Promise<void> {
    await this.ensureSession();
  }

  async authorize(signal: AbortSignal): Promise<void> {
    const { config, scope, remote } = this.options;
    if (!('url' in config)) throw new Error(`MCP server "${this.name}" is not a remote server and has no authorization`);
    if (remote === undefined) throw new Error(`MCP server "${this.name}" has no credential store configured`);
    const guarded = createGuardedFetch({ scope, ...(remote.resolver === undefined ? {} : { resolver: remote.resolver }) });
    try {
      await authorizeMcpServer({
        server: this.name,
        url: config.url,
        scope,
        oauth: config.oauth,
        fetch: guarded.fetch,
        ports: { store: remote.credentials, timers: this.timers, randomToken: remote.randomToken, openAuthorizationUrl: remote.openAuthorizationUrl },
        signal,
      });
    } finally {
      await guarded.close();
    }
    this.lastError = null;
  }

  async listTools(options?: { signal?: AbortSignal }): Promise<Tool[]> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    return this.withLiveSession(signal, async ({ client, transport }) => {
      try {
        return (await client.listTools(undefined, signal === undefined ? undefined : { signal })).tools;
      } catch (error) {
        throw this.failure(transport, error);
      }
    });
  }

  async callTool(input: McpCallToolInput): Promise<CallToolResult> {
    return this.withLiveSession(undefined, async ({ client, transport }) => {
      const meta: Record<string, string> = {};
      if (input.traceparent !== undefined) meta[TRACEPARENT_META_KEY] = input.traceparent;
      if (input.tracestate !== undefined) meta[TRACESTATE_META_KEY] = input.tracestate;
      const timeout = input.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      try {
        return await client.callTool(
          { name: input.name, arguments: input.arguments, ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }) },
          { ...(input.signal === undefined ? {} : { signal: input.signal }), timeout, maxTotalTimeout: timeout },
        );
      } catch (error) {
        if (error instanceof ProtocolError && error.code === TASK_HANDLE_ERROR_CODE) {
          return this.settle(client, transport, error.data, input.signal, timeout);
        }
        throw this.failure(transport, error);
      }
    });
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private trackSecret(value: string, force = false): void {
    if (value.length >= MIN_SECRET_CHARS || force) {
      if (value !== '') this.secrets.add(value);
    }
  }

  private async settle(client: Client, transport: ConnectionTransport, created: unknown, signal: AbortSignal | undefined, timeout: number): Promise<CallToolResult> {
    const stop = new AbortController();
    const forward = (): void => stop.abort(signal?.reason);
    if (signal?.aborted === true) forward();
    signal?.addEventListener('abort', forward, { once: true });
    const deadline = this.timers.setTimeout(() => stop.abort(new Error(`task did not finish within ${timeout}ms`)), timeout);
    const request = async (method: TaskMethod, taskId: string, requestSignal: AbortSignal | undefined): Promise<unknown> =>
      client.request({ method, params: { taskId } }, PASS_THROUGH, {
        timeout: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
      });
    try {
      return await settleTask({ created, request, timers: this.timers, signal: stop.signal });
    } catch (error) {
      throw this.failure(transport, error);
    } finally {
      this.timers.clearTimeout(deadline);
      signal?.removeEventListener('abort', forward);
    }
  }

  private async withLiveSession<T>(signal: AbortSignal | undefined, operation: (session: Session) => Promise<T>): Promise<T> {
    const first = await this.ensureSessionUnless(signal);
    try {
      return await operation(first);
    } catch (error) {
      if (!this.isExpiredSession(first, error)) throw error;
      await this.discardSession(first);
      return operation(await this.ensureSessionUnless(signal));
    }
  }

  private isExpiredSession(session: Session, error: unknown): boolean {
    const cause = error instanceof Error ? (error.cause ?? error) : error;
    return session.transport.sessionId !== undefined && (isSessionExpired(error) || isSessionExpired(cause));
  }

  private async discardSession(session: Session): Promise<void> {
    if (this.session === session) this.session = undefined;
    await session.client.close();
    await session.guarded?.close();
  }

  private async shutdown(): Promise<void> {
    this.lifetime.abort();
    await this.pendingTransport?.close();
    await this.connecting?.catch(() => undefined);
    this.state = 'closed';
    const session = this.session;
    this.session = undefined;
    if (session === undefined) return;
    try {
      if (session.transport.sessionId !== undefined) await this.endSession(session.transport);
    } finally {
      await session.client.close();
      await session.guarded?.close();
    }
  }

  private async endSession(transport: ConnectionTransport): Promise<void> {
    const graceMs = this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    const expired = new AbortController();
    const handle = this.timers.setTimeout(() => expired.abort(), graceMs);
    try {
      await Promise.race([
        transport.terminateSession(),
        new Promise<never>((_resolve, reject) => {
          expired.signal.addEventListener('abort', () => reject(new Error(`MCP server "${this.name}" did not end its session within ${graceMs}ms`)), { once: true });
        }),
      ]);
    } finally {
      this.timers.clearTimeout(handle);
    }
  }

  private failure(transport: ConnectionTransport, error: unknown): Error {
    const detail = describeExit(transport);
    const base = error instanceof Error ? error : new Error(String(error));
    const message = detail === undefined ? base.message : `${base.message} (${detail})`;
    if (detail !== undefined) this.lastError = detail;
    if (message === base.message && !this.secretsInMessage(message)) return base;
    const failure = new Error(this.redact(message), { cause: base });
    failure.name = base.name;
    return failure;
  }

  private secretsInMessage(message: string): boolean {
    for (const secret of this.secrets) if (message.includes(secret)) return true;
    return false;
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

  private openTransport(): { transport: ConnectionTransport; guarded: GuardedFetch | undefined } {
    const { config, scope, remote, projectDir, baseEnv, markers, closeGraceMs } = this.options;
    if (!('url' in config)) {
      const transport = createStdioTransport({
        name: this.name,
        config,
        projectDir,
        baseEnv,
        ...(markers === undefined ? {} : { markers }),
        ...(closeGraceMs === undefined ? {} : { closeGraceMs }),
      });
      return { transport: Object.assign(transport, { terminateSession: () => Promise.resolve() }), guarded: undefined };
    }
    if (remote === undefined) throw new Error(`MCP server "${this.name}" is remote but no credential store was configured`);
    const guarded = createGuardedFetch({ scope, ...(remote.resolver === undefined ? {} : { resolver: remote.resolver }) });
    const staticAuthorization = Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === 'authorization');
    const authProvider: McpOAuthProvider | undefined = staticAuthorization
      ? undefined
      : createMcpOAuthProvider({
          server: this.name,
          resourceUrl: config.url,
          scope,
          store: remote.credentials,
          redirectUrl: undefined,
          randomToken: remote.randomToken,
          ...(config.oauth?.clientId === undefined ? {} : { preregisteredClientId: config.oauth.clientId }),
          ...(config.oauth?.scope === undefined ? {} : { requestedScope: config.oauth.scope }),
          onAuthorizationUrl: () => undefined,
          onSecret: (secret) => this.trackSecret(secret, true),
        });
    try {
      return { transport: createRemoteTransport({ config, scope, fetch: guarded.fetch, authProvider, timers: this.timers }), guarded };
    } catch (error) {
      void guarded.close();
      throw error;
    }
  }

  private async openSession(): Promise<Session> {
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
      if (delay > 0) await pause(this.timers, delay, this.lifetime.signal);
    }
    this.assertOpen();
    const { connectTimeoutMs, config } = this.options;
    let opened: ReturnType<ManagedConnection['openTransport']>;
    try {
      opened = this.openTransport();
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
    const { transport, guarded } = opened;
    this.lastTransport = transport;
    this.pendingTransport = transport;
    const remote = 'url' in config;
    const client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      {
        capabilities: remote ? { extensions: { [TASKS_EXTENSION]: {} } } : {},
        versionNegotiation: { mode: 'auto' },
        inputRequired: { autoFulfill: true, maxRounds: this.options.mrtrMaxRounds ?? MRTR_MAX_ROUNDS },
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
        await guarded?.close();
        throw error instanceof Error ? error : new Error(String(error));
      }
      const failure = this.failure(transport, error);
      this.lastError = failure.message;
      await client.close();
      await guarded?.close();
      if (isDeterministicRemoteFailure(error)) {
        this.state = 'disconnected';
        throw failure;
      }
      this.consecutiveFailures += 1;
      this.breaker.onFailure();
      this.state = this.breaker.state === 'open' ? 'unavailable' : 'disconnected';
      throw failure;
    }
    this.pendingTransport = undefined;
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.breaker.onSuccess();
    const session: Session = { client, transport, guarded };
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

  private handleClose(client: Client, transport: ConnectionTransport): void {
    if (this.session?.client !== client) return;
    this.session = undefined;
    if (this.closing !== undefined) return;
    this.state = 'disconnected';
    this.lastError = describeExit(transport) ?? this.lastError ?? 'connection closed';
  }
}

const PASS_THROUGH = { '~standard': { version: 1, vendor: 'momonga', validate: (value: unknown) => ({ value }) } } as const;

export const createManagedConnection = (options: McpConnectionOptions): ManagedConnection => new ManagedConnection(options);

export type ConnectMcpServerOptions = McpConnectionOptions;

export const connectMcpServer = async (options: ConnectMcpServerOptions): Promise<McpServerConnection> => {
  const connection = createManagedConnection(options);
  await connection.connect();
  return connection;
};
