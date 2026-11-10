import { Client, ProtocolError, SdkError, SdkErrorCode, TRACEPARENT_META_KEY, TRACESTATE_META_KEY, isCallToolResult, isInputRequiredResult } from '@modelcontextprotocol/client';
import type { CallToolResult, Implementation, JSONRPCMessage, ProtocolEra, Tool, Transport } from '@modelcontextprotocol/client';
import { stripCredentialEnv } from '@momonga/config';
import type { CredentialRules, McpServerConfig, McpServerScope } from '@momonga/config';
import { CircuitBreaker, CredentialStoreError, JsonDepthError, MIN_CREDENTIAL_CHARS, OperationLimitError, checkJsonDepth, computeBackoff, limitEndOf, limitEndText, operationLimit, settledOrAborted } from '@momonga/foundation';
import type { Clock, OperationLimit } from '@momonga/foundation';
import { authorizeMcpServer } from './authorize.ts';
import { credentialNoticesOf } from './credential-strength.ts';
import { CLOSE_LIMIT_LABEL, CONNECT_LIMIT_LABEL, CONNECT_SUBJECT, CREDENTIAL_STORE_WAIT, REQUEST_LIMIT_LABEL, REQUEST_SUBJECT } from './limit-texts.ts';
import { createMcpOAuthProvider } from './mcp-oauth.ts';
import type { McpOAuthProvider } from './mcp-oauth.ts';
import { parseInputRequests } from './input-requests.ts';
import { validateStructuredOutput } from './output-validation.ts';
import { createParkedInputs } from './parked-input.ts';
import type { ParkedInputs } from './parked-input.ts';
import { McpRemotePolicyError, McpTaskError, authorizationRequiredFor, deterministicRemoteFailureOf, findInCauseChain, isSessionExpired } from './remote-errors.ts';
import { credentialKey } from './mcp-oauth.ts';
import { createGuardedFetch } from './remote-policy.ts';
import type { GuardedFetch } from './remote-policy.ts';
import type { McpRemotePorts } from './remote-ports.ts';
import { createRemoteTransport } from './remote-transport.ts';
import type { ConnectionTransport } from './remote-transport.ts';
import { mcpToolIdentity } from './tool-identity.ts';
import { createSafeSchemaValidator } from './schema-validator.ts';
import { createStdioTransport } from './stdio-transport.ts';
import { createStoreScope, runInStoreScope, storeCallSignal, storeCallsSettled, storeUnderCallSignals } from './store-scope.ts';
import type { StoreScope } from './store-scope.ts';
import { DEFAULT_CLOSE_GRACE_MS } from './stdio-transport.ts';
import type { McpMarkerOptions } from './stdio-transport.ts';
import { McpInputSuspension } from './suspension.ts';
import type { McpCheckpoint, McpResume } from './suspension.ts';
import { taskHandleOf } from './task-handle.ts';
import type { McpTransportKind } from './call-bounds.ts';
import { DEFAULT_REQUEST_TIMEOUT_MS, settleTask } from './tasks.ts';
import type { SettleTaskOptions, TaskRequester } from './tasks.ts';
import { pause, systemTimers } from './timers.ts';
import type { McpTimers } from './timers.ts';

const CLIENT_NAME = 'momonga';
const CLIENT_VERSION = '0.0.0';
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_RESET_AFTER_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 200;
const BACKOFF_MAX_MS = 5000;
const SECRET_HEADER = /auth|token|key|secret|cookie|password/i;
const DESCRIPTIVE_HEADER = /^(accept(-charset|-encoding|-language)?|content-(type|language)|cache-control|user-agent)$/i;
const REDACTED = '[redacted]';
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
  signal: AbortSignal;
  timeoutMs?: number;
  traceparent?: string;
  tracestate?: string;
  resume?: McpResume;
  onCheckpoint?(checkpoint: McpCheckpoint): void;
  onProgress?(): void;
  pollCeilingMs?: number;
};

export interface McpServerConnection {
  readonly name: string;
  readonly transportKind: McpTransportKind;
  readonly protocolVersion: string | undefined;
  readonly protocolEra: ProtocolEra | undefined;
  readonly serverInfo: Implementation | undefined;
  readonly instructions: string | undefined;
  listTools(options?: { signal?: AbortSignal }): Promise<Tool[]>;
  callTool(input: McpCallToolInput): Promise<CallToolResult>;
  releaseCheckpoint(checkpoint: McpCheckpoint, options?: { signal?: AbortSignal }): Promise<void>;
  cancelOutcome(taskId: string): Promise<boolean> | undefined;
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
  onNotice?: (message: string) => void;
  credentials?: CredentialRules;
  credentialNames?: readonly string[];
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

const SHORTEST_CLOSE_LIMIT_MS = 1;

const closeLimitMsOf = (closeGraceMs: number): number => (closeGraceMs > 0 ? closeGraceMs : SHORTEST_CLOSE_LIMIT_MS);

const ownLimitOf = (limit: OperationLimit, parent: AbortSignal): OperationLimitError | undefined => {
  const reason: unknown = limit.signal.reason;
  return limit.signal.aborted && reason instanceof OperationLimitError && reason !== parent.reason ? reason : undefined;
};

const endedByItsLimit = async (limit: OperationLimit, parent: AbortSignal, scope: StoreScope, bareSubject: string): Promise<Error | undefined> => {
  const own = ownLimitOf(limit, parent);
  if (own === undefined) return undefined;
  await storeCallsSettled(scope);
  const cause = scope.endedStoreCall ?? own;
  return new Error(limitEndText(limitEndOf(cause) ?? { call: undefined, limit: own }, bareSubject), { cause });
};

const idOf = (message: JSONRPCMessage): string | number | undefined => ('id' in message ? message.id : undefined);

type ConfiguredCredential = { label: string; redacted: readonly string[]; judged: string };

const configuredCredentialsOf = (config: McpServerConfig, names: readonly string[], rules: CredentialRules | undefined): ConfiguredCredential[] => {
  if (!('command' in config)) {
    return Object.entries(config.headers ?? {})
      .filter(([header, value]) => !DESCRIPTIVE_HEADER.test(header) && (SECRET_HEADER.test(header) || value.length >= MIN_CREDENTIAL_CHARS))
      .map(([header, value]) => {
        if (!SECRET_HEADER.test(header)) return { label: `header ${header}`, redacted: [value], judged: value };
        const parts = value.split(/\s+/).filter((part) => part !== '');
        return { label: `header ${header}`, redacted: [value, ...parts], judged: parts.at(-1) ?? value };
      });
  }
  const env = config.env ?? {};
  const withheld = new Set(stripCredentialEnv(env, names, rules).removed);
  return Object.entries(env)
    .filter(([name]) => withheld.has(name))
    .map(([name, value]) => ({ label: `variable ${name}`, redacted: [value], judged: value }));
};

export const boundedMessages = (transport: ConnectionTransport, server: string, onNotice: ((message: string) => void) | undefined): ConnectionTransport => {
  const bounded = (handler: NonNullable<Transport['onmessage']>): NonNullable<Transport['onmessage']> => (message, extra) => {
    try {
      checkJsonDepth(message);
    } catch (error) {
      if (!(error instanceof JsonDepthError)) throw error;
      const id = idOf(message);
      if (id === undefined) {
        onNotice?.(`MCP server "${server}" sent a notification that was dropped as too deep: ${error.message}`);
        return;
      }
      const refusal = { jsonrpc: '2.0' as const, id, error: { code: -32603, message: `MCP server "${server}" sent a message that is too deep: ${error.message}` } };
      if ('method' in message) {
        transport.send(refusal).catch((failure: unknown) => onNotice?.(`MCP server "${server}": the depth refusal could not be sent: ${errorMessage(failure)}`));
        return;
      }
      handler(refusal, extra);
      return;
    }
    handler(message, extra);
  };
  return new Proxy(transport, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set: (target, property, value: unknown) => {
      Reflect.set(target, property, property === 'onmessage' && typeof value === 'function' ? bounded(value as NonNullable<Transport['onmessage']>) : value, target);
      return true;
    },
  });
};

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
  private readonly cancels = new Map<string, Promise<boolean>>();
  readonly transportKind: McpTransportKind;

  constructor(options: McpConnectionOptions) {
    this.options = options;
    this.name = options.name;
    this.transportKind = 'url' in options.config ? 'network' : 'stdio';
    this.random = options.random ?? Math.random;
    this.timers = options.timers ?? systemTimers;
    this.inputs = createParkedInputs(options.clock.now(), this.timers);
    this.breaker = new CircuitBreaker({
      failureThreshold: FAILURE_THRESHOLD,
      openMs: options.resetAfterMs ?? DEFAULT_RESET_AFTER_MS,
      clock: options.clock,
    });
    for (const credential of configuredCredentialsOf(options.config, options.credentialNames ?? [], options.credentials)) {
      for (const value of credential.redacted) this.trackSecret(value);
      for (const notice of credentialNoticesOf(this.name, credential.label, credential.judged)) options.onNotice?.(notice);
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

  async authState(signal: AbortSignal): Promise<McpAuthProbe> {
    const { config, remote } = this.options;
    if (!('url' in config)) return { state: 'not_applicable' };
    if (Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === 'authorization')) return { state: 'static_header' };
    if (remote === undefined) throw new Error(`MCP server "${this.name}" has no credential store configured`);
    const live = this.session;
    try {
      if (live === undefined) await this.ensureSessionUnless(signal);
      else await this.listTools({ signal });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (authorizationRequiredFor(error) !== undefined) {
        if (live !== undefined && this.session === live) await this.discardSession(live);
        return { state: 'required' };
      }
      const refusal = findInCauseChain(error, (candidate): candidate is McpRemotePolicyError => candidate instanceof McpRemotePolicyError);
      if (refusal !== undefined) return { state: 'refused', detail: this.redact(refusal.message) };
      return { state: 'unreachable', detail: this.redact(errorMessage(error)) };
    }
    const limit = this.connectLimit(signal);
    try {
      const stored = await remote.credentials.read(credentialKey(this.name, config.url), limit.signal);
      return { state: stored === undefined ? 'not_required' : 'authorized' };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const end = limitEndOf(error);
      return { state: 'unreachable', detail: this.redact(end === undefined ? errorMessage(error) : limitEndText(end, CREDENTIAL_STORE_WAIT)) };
    } finally {
      limit.dispose();
    }
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
        storeLimitMs: this.connectLimitMs(),
      });
    } finally {
      await guarded.close();
    }
    this.lastError = null;
  }

  async listTools(options?: { signal?: AbortSignal }): Promise<Tool[]> {
    options?.signal?.throwIfAborted();
    return this.withinRequestLimit(options?.signal ?? this.lifetime.signal, async (session, signal) => {
      const { tools } = await session.client.listTools(undefined, { signal, timeout: SDK_TIMER_CEILING_MS });
      session.tools = new Map(tools.map((tool) => [tool.name, tool]));
      return tools;
    });
  }

  async callTool(input: McpCallToolInput): Promise<CallToolResult> {
    return runInStoreScope(this.storeScopeUnder(input.signal), () => this.callToolInItsScope(input));
  }

  private callToolInItsScope(input: McpCallToolInput): Promise<CallToolResult> {
    return this.withLiveSession(undefined, async (session, attempt) => {
      const timeout = input.timeoutMs;
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
    await this.withinRequestLimit(options?.signal ?? this.lifetime.signal, async (session, signal) => {
      await this.taskRequester(session.client, SDK_TIMER_CEILING_MS)('tasks/cancel', { taskId: checkpoint.taskId }, signal);
    });
  }

  cancelOutcome(taskId: string): Promise<boolean> | undefined {
    return this.cancels.get(taskId);
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private trackSecret(value: string): void {
    if (value.length >= MIN_CREDENTIAL_CHARS) this.secrets.add(value);
  }

  private connectLimitMs(): number {
    return this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  private connectLimit(parent: AbortSignal): OperationLimit {
    return operationLimit(parent, this.connectLimitMs(), CONNECT_LIMIT_LABEL, this.timers);
  }

  private storeScopeUnder(operation: AbortSignal): StoreScope {
    return createStoreScope(operation, () => this.connectLimit(this.lifetime.signal));
  }

  private async withinRequestLimit<T>(parent: AbortSignal, request: (session: Session, signal: AbortSignal) => Promise<T>): Promise<T> {
    const limit = operationLimit(parent, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, REQUEST_LIMIT_LABEL, this.timers);
    const scope = this.storeScopeUnder(limit.signal);
    try {
      return await runInStoreScope(scope, () =>
        this.withLiveSession(limit.signal, async (session) => {
          try {
            return await request(session, limit.signal);
          } catch (error) {
            throw this.failure(session.transport, (await endedByItsLimit(limit, parent, scope, REQUEST_SUBJECT)) ?? error);
          }
        }),
      );
    } catch (error) {
      throw error === ownLimitOf(limit, parent) ? ((await endedByItsLimit(limit, parent, scope, REQUEST_SUBJECT)) ?? error) : error;
    } finally {
      limit.dispose();
    }
  }

  private async definitionOf(session: Session, name: string, signal: AbortSignal): Promise<Tool> {
    const known = session.tools.get(name);
    if (known !== undefined) return known;
    await this.listTools({ signal });
    const listed = this.session?.tools.get(name);
    if (listed === undefined) throw new McpUnknownToolError(this.name, name);
    return listed;
  }

  private async driveRounds(session: Session, tool: Tool, input: McpCallToolInput, attempt: Attempt, timeout: number | undefined, endBudget: () => void): Promise<CallToolResult> {
    const { client } = session;
    const maxRounds = this.options.mrtrMaxRounds ?? MRTR_MAX_ROUNDS;
    const stop = input.signal;
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
          {
            signal: stop,
            timeout: SDK_TIMER_CEILING_MS,
            allowInputRequired: true,
            toolDefinition: callableTool,
            ...(input.onProgress === undefined ? {} : { onprogress: () => input.onProgress?.() }),
          },
        );
      } catch (error) {
        const handle = error instanceof ProtocolError ? taskHandleOf(error.code, error.data) : undefined;
        if (handle !== undefined) {
          endBudget();
          return await this.settle(session, tool, input, attempt, { created: handle }, timeout);
        }
        throw error;
      }
      if (!isInputRequiredResult(result)) return await validateStructuredOutput(mcpToolIdentity(this.name, input.name), input.name, tool, result, stop);
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
    timeout: number | undefined,
  ): Promise<CallToolResult> {
    const { signal } = input;
    const stop = new AbortController();
    const forward = (): void => stop.abort(signal.reason);
    if (signal.aborted) forward();
    signal.addEventListener('abort', forward, { once: true });
    const deadline = timeout === undefined ? undefined : this.timers.setTimeout(() => stop.abort(new Error(`task did not finish within ${timeout}ms`)), timeout);
    const request = this.taskRequester(client, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
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
        trackCancel: (outcome, taskId) => {
          this.cancels.set(
            taskId,
            outcome.then(
              () => true,
              (error: unknown) => {
                this.lastError = `tasks/cancel for an aborted call failed: ${errorMessage(error)}`;
                return false;
              },
            ),
          );
        },
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
        ...(input.pollCeilingMs === undefined ? {} : { pollCeilingMs: input.pollCeilingMs }),
        accept: async (taskId, value) => {
          if (!isCallToolResult(value)) throw new McpTaskError(taskId, `task ${taskId} completed with a result that is not a tool result`);
          return validateStructuredOutput(mcpToolIdentity(this.name, input.name), input.name, tool, value, stop.signal);
        },
      });
    } finally {
      if (deadline !== undefined) this.timers.clearTimeout(deadline);
      signal.removeEventListener('abort', forward);
    }
  }

  private taskRequester(client: Session['client'], timeout: number): TaskRequester {
    return async (method, params, requestSignal) =>
      client.request({ method, params }, PASS_THROUGH, {
        timeout,
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
    const close = new AbortController();
    const limit = operationLimit(close.signal, closeLimitMsOf(graceMs), CLOSE_LIMIT_LABEL, this.timers);
    const scope = this.storeScopeUnder(limit.signal);
    try {
      await runInStoreScope(scope, () => settledOrAborted(transport.terminateSession(), limit.signal));
    } catch (error) {
      if (ownLimitOf(limit, close.signal) === undefined) throw error;
      await storeCallsSettled(scope);
      const unfinished = `MCP server "${this.name}" did not end its session within ${graceMs}ms`;
      const ended = scope.endedStoreCall;
      if (ended === undefined) throw new Error(unfinished);
      throw new Error(`${unfinished}: ${limitEndText({ call: ended.call, limit: ended.limit }, CREDENTIAL_STORE_WAIT)}`, { cause: ended });
    } finally {
      limit.dispose();
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
          store: storeUnderCallSignals(remote.credentials),
          signalForCall: () => storeCallSignal(() => this.connectLimit(this.lifetime.signal)),
          redirectUrl: undefined,
          randomToken: remote.randomToken,
          ...(config.oauth?.clientId === undefined ? {} : { preregisteredClientId: config.oauth.clientId }),
          ...(config.oauth?.scope === undefined ? {} : { requestedScope: config.oauth.scope }),
          onAuthorizationUrl: () => undefined,
          onSecret: (secret) => this.trackSecret(secret),
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
    const { config } = this.options;
    let opened: ReturnType<ManagedConnection['openTransport']>;
    try {
      opened = this.openTransport();
    } catch (error) {
      this.lastError = errorMessage(error);
      throw error;
    }
    const { guarded } = opened;
    const transport = boundedMessages(opened.transport, this.name, this.options.onNotice);
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
    const limit = this.connectLimit(this.lifetime.signal);
    const scope = this.storeScopeUnder(limit.signal);
    try {
      await runInStoreScope(scope, () => settledOrAborted(client.connect(transport, { timeout: SDK_TIMER_CEILING_MS, signal: limit.signal }), limit.signal));
    } catch (error) {
      this.pendingTransport = undefined;
      if (this.lifetime.signal.aborted) {
        await client.close();
        await guarded?.close();
        throw error instanceof Error ? error : new Error(String(error));
      }
      const deterministic = deterministicRemoteFailureOf(error);
      const failure = this.failure(transport, (await endedByItsLimit(limit, this.lifetime.signal, scope, CONNECT_SUBJECT)) ?? (deterministic instanceof CredentialStoreError ? deterministic : error));
      this.lastError = failure.message;
      await client.close();
      await guarded?.close();
      if (deterministic !== undefined) {
        this.state = 'disconnected';
        this.lastError = deterministic.message;
        throw deterministic instanceof McpRemotePolicyError ? deterministic : failure;
      }
      this.consecutiveFailures += 1;
      this.breaker.onFailure();
      this.state = this.breaker.state === 'open' ? 'unavailable' : 'disconnected';
      throw failure;
    } finally {
      limit.dispose();
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
