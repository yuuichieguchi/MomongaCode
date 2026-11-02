import { Client, ProtocolError, SdkError, SdkErrorCode, TRACEPARENT_META_KEY, TRACESTATE_META_KEY, isCallToolResult, isInputRequiredResult } from '@modelcontextprotocol/client';
import type { CallToolResult, Implementation, ProtocolEra, Tool } from '@modelcontextprotocol/client';
import type { McpServerConfig, McpServerScope } from '@momonga/config';
import { CircuitBreaker, computeBackoff } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { authorizeMcpServer } from './authorize.ts';
import { createMcpOAuthProvider } from './oauth-provider.ts';
import type { McpOAuthProvider } from './oauth-provider.ts';
import { parseInputRequests } from './input-requests.ts';
import { validateStructuredOutput } from './output-validation.ts';
import { createParkedInputs } from './parked-input.ts';
import type { ParkedInputs } from './parked-input.ts';
import { McpRemotePolicyError, McpTaskError, authorizationRequiredFor, deterministicRemoteFailureOf, findInCauseChain, isSessionExpired } from './remote-errors.ts';
import { credentialKey } from './oauth-provider.ts';
import { createGuardedFetch } from './remote-policy.ts';
import type { GuardedFetch } from './remote-policy.ts';
import type { McpRemotePorts } from './remote-ports.ts';
import { createRemoteTransport } from './remote-transport.ts';
import type { ConnectionTransport } from './remote-transport.ts';
import { createSafeSchemaValidator } from './schema-validator.ts';
import { createStdioTransport } from './stdio-transport.ts';
import { DEFAULT_CLOSE_GRACE_MS } from './stdio-transport.ts';
import type { McpMarkerOptions } from './stdio-transport.ts';
import { McpInputSuspension } from './suspension.ts';
import type { McpCheckpoint, McpResume } from './suspension.ts';
import { taskHandleOf } from './task-handle.ts';
import { settleTask } from './tasks.ts';
import type { SettleTaskOptions, TaskRequester } from './tasks.ts';
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
const DESCRIPTIVE_HEADER = /^(accept(-charset|-encoding|-language)?|content-(type|language)|cache-control|user-agent)$/i;
const REDACTED = '[redacted]';
// The SDK arms a wall-clock timer per request that cannot be paused while a call is parked for the person; the call's own budget runs on the injected timers, so the SDK timer is set to the longest delay Node accepts.
const SDK_TIMER_CEILING_MS = 2_147_483_647;

export const MRTR_MAX_ROUNDS = 10;
export const MRTR_STATE_ONLY_PACING_MS = 250;
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

export type McpAuthProbe = { state: 'not_applicable' | 'static_header' | 'not_required' | 'authorized' | 'required' | 'refused' | 'unreachable'; detail?: string };

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
  resume?: McpResume;
  onCheckpoint?(checkpoint: McpCheckpoint): void;
};

export interface McpServerConnection {
  readonly name: string;
  readonly protocolVersion: string | undefined;
  readonly protocolEra: ProtocolEra | undefined;
  readonly serverInfo: Implementation | undefined;
  readonly instructions: string | undefined;
  listTools(options?: { signal?: AbortSignal }): Promise<Tool[]>;
  callTool(input: McpCallToolInput): Promise<CallToolResult>;
  releaseCheckpoint(checkpoint: McpCheckpoint, options?: { signal?: AbortSignal }): Promise<void>;
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

export class McpUnknownToolError extends Error {
  readonly server: string;
  readonly tool: string;

  constructor(server: string, tool: string) {
    super(`MCP server "${server}" does not list a tool named "${tool}"`);
    this.name = 'McpUnknownToolError';
    this.server = server;
    this.tool = tool;
  }
}

type Attempt = { taskCheckpoint: McpCheckpoint | undefined };

type Session = { client: Client; transport: ConnectionTransport; guarded: GuardedFetch | undefined; tools: Map<string, Tool> };

const describeExit = (transport: ConnectionTransport): string | undefined => {
  const { exit } = transport.diagnostics();
  if (exit === null) return undefined;
  return exit.signal === null ? `server exited with code ${exit.code}` : `server exited with signal ${exit.signal}`;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
  private readonly inputs: ParkedInputs;

  constructor(options: McpConnectionOptions) {
    this.options = options;
    this.name = options.name;
    this.random = options.random ?? Math.random;
    this.timers = options.timers ?? systemTimers;
    this.inputs = createParkedInputs(options.clock.now(), this.timers);
    this.breaker = new CircuitBreaker({
      failureThreshold: FAILURE_THRESHOLD,
      openMs: options.resetAfterMs ?? DEFAULT_RESET_AFTER_MS,
      clock: options.clock,
    });
    if ('headers' in options.config) {
      for (const [header, value] of Object.entries(options.config.headers ?? {})) {
        if (DESCRIPTIVE_HEADER.test(header)) continue;
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

  async authState(): Promise<McpAuthProbe> {
    const { config, remote } = this.options;
    if (!('url' in config)) return { state: 'not_applicable' };
    if (Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === 'authorization')) return { state: 'static_header' };
    if (remote === undefined) throw new Error(`MCP server "${this.name}" has no credential store configured`);
    const live = this.session;
    try {
      if (live === undefined) await this.ensureSession();
      else await this.listTools();
    } catch (error) {
      if (authorizationRequiredFor(error) !== undefined) {
        if (live !== undefined && this.session === live) await this.discardSession(live);
        return { state: 'required' };
      }
      const refusal = findInCauseChain(error, (candidate): candidate is McpRemotePolicyError => candidate instanceof McpRemotePolicyError);
      if (refusal !== undefined) return { state: 'refused', detail: this.redact(refusal.message) };
      return { state: 'unreachable', detail: this.redact(errorMessage(error)) };
    }
    const stored = await remote.credentials.read(credentialKey(this.name, config.url));
    return { state: stored === undefined ? 'not_required' : 'authorized' };
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
    return this.withLiveSession(signal, async (session) => {
      try {
        const { tools } = await session.client.listTools(undefined, signal === undefined ? undefined : { signal });
        session.tools = new Map(tools.map((tool) => [tool.name, tool]));
        return tools;
      } catch (error) {
        throw this.failure(session.transport, error);
      }
    });
  }

  async callTool(input: McpCallToolInput): Promise<CallToolResult> {
    return this.withLiveSession(undefined, async (session, attempt) => {
      const timeout = input.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const resume = attempt.taskCheckpoint === undefined ? input.resume : { checkpoint: attempt.taskCheckpoint, answers: input.resume?.answers ?? {} };
      const current: McpCallToolInput = { ...input, ...(resume === undefined ? {} : { resume }) };
      try {
        const tool = await this.definitionOf(session, current.name, current.signal);
        if (resume?.checkpoint.kind === 'parked') return await this.inputs.resume(resume.checkpoint.parkId, resume.answers, timeout, current.signal);
        if (resume?.checkpoint.kind === 'task') {
          return await this.settle(session, tool, current, attempt, { taskId: resume.checkpoint.taskId, answered: resume.checkpoint.answered }, timeout);
        }
        return await this.inputs.run(current.signal, timeout, (signal, endBudget) => this.driveRounds(session, tool, { ...current, signal }, attempt, timeout, endBudget));
      } catch (error) {
        if (error instanceof McpInputSuspension) throw error;
        throw this.failure(session.transport, error);
      }
    });
  }

  async releaseCheckpoint(checkpoint: McpCheckpoint, options?: { signal?: AbortSignal }): Promise<void> {
    if (checkpoint.kind === 'parked') {
      this.inputs.release(checkpoint.parkId);
      return;
    }
    if (checkpoint.kind !== 'task') return;
    const signal = options?.signal;
    await this.withLiveSession(signal, async (session) => {
      try {
        await this.taskRequester(session.client)('tasks/cancel', { taskId: checkpoint.taskId }, signal);
      } catch (error) {
        throw this.failure(session.transport, error);
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

  private async definitionOf(session: Session, name: string, signal: AbortSignal | undefined): Promise<Tool> {
    const known = session.tools.get(name);
    if (known !== undefined) return known;
    await this.listTools(signal === undefined ? undefined : { signal });
    const listed = this.session?.tools.get(name);
    if (listed === undefined) throw new McpUnknownToolError(this.name, name);
    return listed;
  }

  private async driveRounds(session: Session, tool: Tool, input: McpCallToolInput, attempt: Attempt, timeout: number, endBudget: () => void): Promise<CallToolResult> {
    const { client } = session;
    const maxRounds = this.options.mrtrMaxRounds ?? MRTR_MAX_ROUNDS;
    const stop = input.signal ?? this.lifetime.signal;
    const meta: Record<string, string> = {};
    if (input.traceparent !== undefined) meta[TRACEPARENT_META_KEY] = input.traceparent;
    if (input.tracestate !== undefined) meta[TRACESTATE_META_KEY] = input.tracestate;
    const { outputSchema: _validatedHere, ...callableTool } = tool;
    const checkpoint = input.resume?.checkpoint;
    let rounds = checkpoint?.kind === 'mrtr' ? checkpoint.rounds : 0;
    let requestState = checkpoint?.kind === 'mrtr' ? checkpoint.requestState : undefined;
    let responses = input.resume !== undefined && Object.keys(input.resume.answers).length > 0 ? input.resume.answers : undefined;
    for (;;) {
      let result;
      try {
        result = await client.callTool(
          {
            name: input.name,
            arguments: input.arguments,
            ...(responses === undefined ? {} : { inputResponses: responses }),
            ...(requestState === undefined ? {} : { requestState }),
            ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }),
          },
          { signal: stop, timeout: SDK_TIMER_CEILING_MS, allowInputRequired: true, toolDefinition: callableTool },
        );
      } catch (error) {
        const handle = error instanceof ProtocolError ? taskHandleOf(error.code, error.data) : undefined;
        if (handle !== undefined) {
          endBudget();
          return await this.settle(session, tool, input, attempt, { created: handle }, timeout);
        }
        throw error;
      }
      if (!isInputRequiredResult(result)) return validateStructuredOutput(input.name, tool, result);
      rounds += 1;
      if (rounds > maxRounds) {
        throw new SdkError(SdkErrorCode.InputRequiredRoundsExceeded, `Multi-round-trip request 'tools/call' still required input after ${maxRounds} rounds`, { rounds: maxRounds });
      }
      requestState = result.requestState;
      responses = undefined;
      const entries = result.inputRequests ?? {};
      if (Object.keys(entries).length > 0) {
        throw new McpInputSuspension(parseInputRequests(entries), { kind: 'mrtr', rounds, ...(requestState === undefined ? {} : { requestState }) });
      }
      await pause(this.timers, MRTR_STATE_ONLY_PACING_MS, stop);
      stop.throwIfAborted();
    }
  }

  private async settle(
    { client }: Session,
    tool: Tool,
    input: McpCallToolInput,
    attempt: Attempt,
    start: SettleTaskOptions['start'],
    timeout: number,
  ): Promise<CallToolResult> {
    const { signal } = input;
    const stop = new AbortController();
    const forward = (): void => stop.abort(signal?.reason);
    if (signal?.aborted === true) forward();
    signal?.addEventListener('abort', forward, { once: true });
    const deadline = this.timers.setTimeout(() => stop.abort(new Error(`task did not finish within ${timeout}ms`)), timeout);
    const request = this.taskRequester(client);
    try {
      return await settleTask({
        start,
        answers: input.resume?.answers ?? {},
        request,
        timers: this.timers,
        clock: this.options.clock,
        signal: stop.signal,
        onCheckpoint: (next) => {
          attempt.taskCheckpoint = next;
          input.onCheckpoint?.(next);
        },
        accept: (taskId, value) => {
          if (!isCallToolResult(value)) throw new McpTaskError(taskId, `task ${taskId} completed with a result that is not a tool result`);
          return validateStructuredOutput(input.name, tool, value);
        },
      });
    } finally {
      this.timers.clearTimeout(deadline);
      signal?.removeEventListener('abort', forward);
    }
  }

  private taskRequester(client: Session['client']): TaskRequester {
    return async (method, params, requestSignal) =>
      client.request({ method, params }, PASS_THROUGH, {
        timeout: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
      });
  }

  private async withLiveSession<T>(signal: AbortSignal | undefined, operation: (session: Session, attempt: Attempt) => Promise<T>): Promise<T> {
    const first = await this.ensureSessionUnless(signal);
    const attempt: Attempt = { taskCheckpoint: undefined };
    const deliveredBefore = first.transport.toolCallsDelivered();
    try {
      return await operation(first, attempt);
    } catch (error) {
      if (!this.isExpiredSession(first, error)) throw error;
      const redelivers = first.transport.toolCallsDelivered() > deliveredBefore && attempt.taskCheckpoint === undefined;
      if (redelivers) throw error;
      await this.discardSession(first);
      return operation(await this.ensureSessionUnless(signal), attempt);
    }
  }

  private isExpiredSession(session: Session, error: unknown): boolean {
    const cause = error instanceof Error ? (error.cause ?? error) : error;
    return session.transport.sessionId !== undefined && (isSessionExpired(error) || isSessionExpired(cause));
  }

  private async discardSession(session: Session): Promise<void> {
    if (this.session === session) this.session = undefined;
    this.inputs.closeAll();
    await session.client.close();
    await session.guarded?.close();
  }

  private async shutdown(): Promise<void> {
    this.lifetime.abort();
    this.inputs.closeAll();
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
      return { transport: Object.assign(transport, { terminateSession: () => Promise.resolve(), toolCallsDelivered: () => 0 }), guarded: undefined };
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
        capabilities: { elicitation: { form: {}, url: {} }, ...(remote ? { extensions: { [TASKS_EXTENSION]: {} } } : {}) },
        versionNegotiation: { mode: 'auto' },
        inputRequired: { autoFulfill: false },
        jsonSchemaValidator: createSafeSchemaValidator(),
        listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => undefined } },
      },
    );
    client.setRequestHandler('elicitation/create', async (request) => this.inputs.serverRequest(request.params));
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
      const deterministic = deterministicRemoteFailureOf(error);
      if (deterministic !== undefined) {
        this.state = 'disconnected';
        this.lastError = deterministic.message;
        throw deterministic instanceof McpRemotePolicyError ? deterministic : failure;
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
    const session: Session = { client, transport, guarded, tools: new Map() };
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
    this.inputs.closeAll();
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
