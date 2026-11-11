import type { McpServerConfig } from '@momonga/config';
import { HOST_READ_BOUND_MS, MOVED_CODE, createUdsClient, decodeSse, isRecord, parseRetryAfter } from '@momonga/foundation';
import type { SocketResolver, UdsResponse } from '@momonga/foundation';
import { DAEMON_CURRENT_EVENT, STREAM_FAILED_EVENT, WORDS, messageOf } from '@momonga/protocol';
import type { AddMemoryRequest, AddRuleRequest, PutRuleVerdictRequest, RuleVerdict, AdoptGuidelineRequest, AgentsResponse, ContextChargeView, CostBreakdownView, CostReportView, GuidelineView, GuidelinesResponse, RecordContextChargeRequest, GoverningFactView, JobView, ElicitationAnswerRecord, ImageAttachment, UserShellRecord, InboxAddResponse, InboxDelivery, InboxRowView, InboxWithdrawResponse, McpAuthorizationView, McpServerView, MemoryScope, MemoryState, MemoryView, PermissionMode, PolicyGovernanceResponse, PublicRunEvent, ReflectionJobView, RunAnsweredByView, RunReflectionView, RuleAddResponse, RunHealth, ReportPage, RunTraceView, SkillsResponse, PermissionReviewView, ReviewPage, RunCostView, StoreReviewRequest, TraceContentPage, Mandate } from '@momonga/protocol';
import {
  ContractViolation,
  checkAgents,
  checkApproval,
  checkContextCharge,
  checkCostBreakdown,
  checkCostReport,
  checkElicitation,
  checkGuideline,
  checkGuidelines,
  checkErrorBody,
  checkHealth,
  checkInbox,
  checkInboxAdd,
  checkInboxWithdraw,
  checkJobs,
  checkRunSuccessor,
  checkUserShellFrame,
  checkUserShellPending,
  checkMcpAuthorization,
  checkMcpServers,
  checkMemories,
  checkMemory,
  checkPolicyGovernance,
  checkPromoted,
  checkReflection,
  checkReportCost,
  checkReportPage,
  checkReviewPage,
  checkStoreReview,
  checkTraceContent,
  checkRunAnsweredBy,
  checkRunReflection,
  checkRule,
  checkRuleAdd,
  checkRules,
  checkRun,
  checkRunEvent,
  checkSession,
  checkSkills,
  checkTrace,
  checkTrust,
} from './contract.ts';
import type { CliClock } from '../ports.ts';
import { UsageError } from '../usage-error.ts';
import type { ApprovalView, ElicitationView, RunView, SessionView, TrustView } from './views.ts';

export class RunApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly code: string | undefined;
  readonly reason: string;

  constructor(description: string, status: number, text: string) {
    let body: unknown = text;
    let code: string | undefined;
    let message = text;
    try {
      body = JSON.parse(text);
      const checked = checkErrorBody(body, description);
      code = checked.error.code;
      message = checked.error.message;
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof ContractViolation)) throw error;
    }
    super(`${description} answered ${status}: ${message}`);
    this.name = 'RunApiError';
    this.reason = message;
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

export const MOVED_RESENDS = 3;

const SOCKET_ERROR_RESENDS = 1;

const RESENT_SOCKET_CODES: ReadonlySet<string> = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

const REPEATABLE_METHODS: ReadonlySet<string> = new Set(['GET', 'PUT', 'PATCH', 'DELETE']);

export class StreamFailed extends Error {
  readonly code: string;

  constructor(description: string, code: string, message: string) {
    super(`the ${WORDS.daemon} could not go on with the event stream (${description}): ${message}`);
    this.name = 'StreamFailed';
    this.code = code;
  }
}

export class DaemonMoved extends Error {
  readonly generation: number;
  readonly version: string;

  constructor(generation: number, version: string) {
    super(`the daemon moved to generation ${generation} (v${version})`);
    this.name = 'DaemonMoved';
    this.generation = generation;
    this.version = version;
  }
}

export type RunEventFrame = { readonly id: number; readonly event: string | undefined; readonly data: PublicRunEvent };

export type EventsOptions = { after?: number; lastEventId?: number; signal?: AbortSignal; onOpen?: () => void };

export type CreateSessionInput = {
  cwd: string;
  env: Readonly<Record<string, string>>;
  permissionMode?: PermissionMode;
  model?: string;
  bypassAllowed?: boolean;
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
};

export type CreateRunOptions = {
  history?: 'inherit' | 'fresh';
  idempotencyKey?: string;
  skill?: string;
  timeoutMs?: number;
  limits?: { maxSteps?: number; maxTotalTokens?: number; maxCostUsd?: number };
  images?: readonly ImageAttachment[];
  attachMentions?: boolean;
  mandate?: Mandate;
};

export type UserShellEnd = { kind: 'refused'; reason: string } | { kind: 'exit'; record: UserShellRecord };

export type MemoryFilter = { scope?: MemoryScope; state?: MemoryState; project?: string };

export type CostFilter = { run: string } | { session: string } | { cwd: string } | Record<string, never>;

export type ResolvedElicitation = { elicitation: ElicitationView; run: RunView };

export type CreatedSession = { session: SessionView; strippedEnvKeys: string[] };

export type ResolvedApproval = { approval: ApprovalView; run: RunView };

export type RuntimeClient = {
  health(): Promise<RunHealth>;
  createSession(input: CreateSessionInput): Promise<CreatedSession>;
  getSession(id: string): Promise<SessionView>;
  listSessions(cwd?: string): Promise<SessionView[]>;
  listRuns(sessionId: string): Promise<RunView[]>;
  skills(sessionId: string): Promise<SkillsResponse>;
  agents(sessionId: string): Promise<AgentsResponse>;
  jobs(sessionId: string): Promise<JobView[]>;
  childRuns(runId: string): Promise<RunView[]>;
  setMcpServers(sessionId: string, servers: Readonly<Record<string, McpServerConfig>>): Promise<SessionView>;
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionView>;
  setModel(sessionId: string, model: string): Promise<SessionView>;
  createRun(sessionId: string, input: string, options?: CreateRunOptions): Promise<{ run: RunView; location: string }>;
  compact(sessionId: string, instructions?: string): Promise<RunView>;
  getRun(id: string): Promise<RunView>;
  inboxAdd(sessionId: string, delivery: InboxDelivery, text: string, images?: readonly ImageAttachment[]): Promise<InboxAddResponse>;
  inboxWithdraw(id: string): Promise<InboxWithdrawResponse>;
  inboxList(sessionId: string): Promise<InboxRowView[]>;
  runSuccessor(runId: string): Promise<RunView | undefined>;
  userShell(sessionId: string, command: string, include: boolean, onOutput: (text: string) => void): Promise<UserShellEnd>;
  stopUserShell(sessionId: string): Promise<void>;
  pendingUserShell(sessionId: string): Promise<UserShellRecord[]>;
  cancel(id: string): Promise<{ status: 200 | 202; run: RunView }>;
  trace(runId: string): Promise<RunTraceView>;
  approvals(runId: string): Promise<ApprovalView[]>;
  getApproval(id: string): Promise<ApprovalView>;
  resolveApproval(id: string, optionId: string): Promise<ResolvedApproval>;
  skills(sessionId: string): Promise<SkillsResponse>;
  elicitations(runId: string): Promise<ElicitationView[]>;
  getElicitation(id: string): Promise<ElicitationView>;
  resolveElicitation(id: string, responses: Readonly<Record<string, ElicitationAnswerRecord>>): Promise<ResolvedElicitation>;
  mcpServers(sessionId: string): Promise<McpServerView[]>;
  startMcpAuthorization(sessionId: string, server: string): Promise<McpAuthorizationView>;
  mcpAuthorization(sessionId: string, server: string): Promise<McpAuthorizationView>;
  cancelMcpAuthorization(sessionId: string, server: string): Promise<void>;
  memories(filter?: MemoryFilter): Promise<MemoryView[]>;
  lastReflection(project: string): Promise<ReflectionJobView | null>;
  runReflection(runId: string): Promise<RunReflectionView>;
  runAnsweredBy(runId: string): Promise<RunAnsweredByView>;
  memory(id: string): Promise<MemoryView>;
  addMemory(request: AddMemoryRequest): Promise<MemoryView>;
  deleteMemory(id: string): Promise<void>;
  memoryHistory(id: string): Promise<MemoryView[]>;
  acceptMemory(id: string): Promise<MemoryView>;
  rejectMemory(id: string): Promise<MemoryView>;
  restoreMemory(id: string): Promise<MemoryView>;
  promoteMemory(id: string, skill: string): Promise<string>;
  rules(project: string): Promise<GoverningFactView[]>;
  addRule(request: AddRuleRequest): Promise<RuleAddResponse>;
  retireRule(id: string): Promise<GoverningFactView>;
  ruleHistory(id: string): Promise<GoverningFactView[]>;
  ignoreMarker(name: string): Promise<void>;
  policyGovernance(project: string): Promise<PolicyGovernanceResponse>;
  putRuleVerdict(fingerprint: string, verdict: RuleVerdict): Promise<void>;
  guidelines(): Promise<GuidelinesResponse>;
  adoptGuideline(request: AdoptGuidelineRequest): Promise<GuidelineView>;
  rollbackGuideline(version: number): Promise<GuidelineView>;
  recordContextCharge(request: RecordContextChargeRequest): Promise<ContextChargeView>;
  reportFacts(request: { cursor: string | null; limit: number }): Promise<ReportPage>;
  reportReviews(request: { cursor: string | null; limit: number }): Promise<ReviewPage>;
  storeReview(request: StoreReviewRequest): Promise<PermissionReviewView>;
  reportCost(runIds: readonly string[]): Promise<RunCostView[]>;
  traceContent(runId: string, request: { after: number; limit: number }): Promise<TraceContentPage>;
  cost(filter?: CostFilter): Promise<CostReportView>;
  costText(filter?: CostFilter): Promise<string>;
  costBreakdown(filter?: CostFilter): Promise<CostBreakdownView>;
  costBreakdownText(filter?: CostFilter): Promise<string>;
  trust(path: string): Promise<TrustView>;
  setTrust(path: string, decision: 'trusted' | 'untrusted'): Promise<TrustView>;
  streamEvents(runId: string, options?: EventsOptions): AsyncGenerator<RunEventFrame>;
  streamSessionEvents(sessionId: string, options?: EventsOptions): AsyncGenerator<RunEventFrame>;
  close(): Promise<void>;
};

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export const eventsQueryOf = (options: EventsOptions): string => (options.after === undefined ? '' : `?after=${options.after}`);

export const eventsHeadersOf = (options: EventsOptions): Record<string, string> => ({
  accept: 'text/event-stream',
  ...(options.lastEventId === undefined ? {} : { 'last-event-id': String(options.lastEventId) }),
});

export const createRunBody = (input: string, options: CreateRunOptions = {}): Record<string, unknown> => ({
  input,
  ...(options.history === undefined ? {} : { history: options.history }),
  ...(options.skill === undefined ? {} : { skill: options.skill }),
  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  ...(options.limits === undefined ? {} : { limits: options.limits }),
  ...(options.images === undefined || options.images.length === 0 ? {} : { images: options.images }),
  ...(options.attachMentions === true ? { attachMentions: true } : {}),
  ...(options.mandate === undefined ? {} : { mandate: options.mandate }),
});

const parsed = (text: string, description: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ContractViolation(description, `not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
};

const fieldOf = (body: unknown, key: string, description: string): unknown => {
  if (!isRecord(body) || !(key in body)) throw new ContractViolation(description, `missing ${key}`);
  return body[key];
};

const listOf = (body: unknown, key: string, description: string): unknown[] => {
  const list = fieldOf(body, key, description);
  if (!Array.isArray(list)) throw new ContractViolation(description, `${key} is not a list`);
  return list;
};

const movedOf = (data: string, description: string): DaemonMoved => {
  const body = parsed(data, description);
  if (!isRecord(body) || typeof body['generation'] !== 'number' || typeof body['version'] !== 'string') throw new ContractViolation(description, `a ${DAEMON_CURRENT_EVENT} frame without a generation and a version: ${data}`);
  return new DaemonMoved(body['generation'], body['version']);
};

const failedOf = (data: string, description: string): StreamFailed => {
  const body = parsed(data, description);
  if (!isRecord(body) || typeof body['code'] !== 'string' || typeof body['message'] !== 'string') throw new ContractViolation(description, `a ${STREAM_FAILED_EVENT} frame without a code and a message: ${data}`);
  return new StreamFailed(description, body['code'], body['message']);
};

const socketErrorCodeOf = (error: unknown): string | undefined => {
  for (let current: unknown = error; isRecord(current); current = current['cause']) {
    if (typeof current['code'] === 'string' && RESENT_SOCKET_CODES.has(current['code'])) return current['code'];
  }
  return undefined;
};

const frameOf = (event: { id?: string; event?: string; data: string }, description: string): RunEventFrame => {
  if (event.id === undefined && event.event === DAEMON_CURRENT_EVENT) throw movedOf(event.data, description);
  if (event.id === undefined && event.event === STREAM_FAILED_EVENT) throw failedOf(event.data, description);
  if (event.id === undefined) throw new ContractViolation(description, `an event without an id: ${event.data}`);
  const id = Number(event.id);
  if (!Number.isInteger(id)) throw new ContractViolation(description, `an event with a non-integer id ${event.id}`);
  return { id, event: event.event, data: checkRunEvent(parsed(event.data, description), description) };
};

const NO_SEGMENT = new Set(['', '.', '..']);

export const pathSegment = (value: string): string => {
  if (NO_SEGMENT.has(value)) throw new UsageError(messageOf('notAnId', 'cli', { value }));
  return encodeURIComponent(value);
};

export type RuntimeClientOptions = { resolveSocket: SocketResolver; clock: Pick<CliClock, 'now' | 'sleep'>; onMoved?: () => Promise<void> };

export const createRuntimeClient = (options: RuntimeClientOptions): RuntimeClient => {
  const http = createUdsClient(options.resolveSocket, { headersTimeoutMs: HOST_READ_BOUND_MS });

  const send = async (
    method: string,
    path: string,
    expected: readonly number[],
    init: { body?: unknown; headers?: Record<string, string>; raw?: true } = {},
  ): Promise<{ response: UdsResponse; body: unknown }> => {
    const description = `${method} ${path}`;
    const headers: Record<string, string> = { ...(init.body === undefined ? {} : JSON_HEADERS), ...init.headers };
    const repeatable = REPEATABLE_METHODS.has(method) || (method === 'POST' && headers['idempotency-key'] !== undefined);
    let socketResends = 0;
    for (let movedResends = 0; ; ) {
      let response: UdsResponse;
      try {
        response = await http.request({
          method,
          path,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
      } catch (error) {
        if (!repeatable || socketResends >= SOCKET_ERROR_RESENDS || socketErrorCodeOf(error) === undefined) throw error;
        socketResends += 1;
        continue;
      }
      const text = await response.text();
      if (expected.includes(response.status)) return { response, body: response.status === 204 ? undefined : init.raw === true ? text : parsed(text, description) };
      const failure = new RunApiError(description, response.status, text);
      if (response.status !== 503 || failure.code !== MOVED_CODE || movedResends >= MOVED_RESENDS) throw failure;
      const retryAfterMs = parseRetryAfter(response.headers['retry-after'], options.clock.now());
      if (retryAfterMs === undefined) throw failure;
      await options.onMoved?.();
      movedResends += 1;
      await options.clock.sleep(retryAfterMs);
    }
  };

  const sessionOf = (body: unknown, description: string): SessionView => checkSession(fieldOf(body, 'session', description), description);

  const runOf = (body: unknown, description: string): RunView => checkRun(fieldOf(body, 'run', description), description);

  const health = async (): Promise<RunHealth> => {
    const { body } = await send('GET', '/v1/health', [200]);
    return checkHealth(body, 'GET /v1/health');
  };

  const createSession = async (input: CreateSessionInput): Promise<CreatedSession> => {
    const description = 'POST /v1/sessions';
    const { body } = await send('POST', '/v1/sessions', [201], {
      body: {
        cwd: input.cwd,
        env: input.env,
        ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.bypassAllowed === undefined ? {} : { bypassAllowed: input.bypassAllowed }),
        ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
      },
    });
    const stripped = listOf(body, 'strippedEnvKeys', description);
    if (!stripped.every((key): key is string => typeof key === 'string')) throw new ContractViolation(description, 'strippedEnvKeys holds a non-string');
    return { session: sessionOf(body, description), strippedEnvKeys: stripped };
  };

  const getSession = async (id: string): Promise<SessionView> => {
    const path = `/v1/sessions/${pathSegment(id)}`;
    const { body } = await send('GET', path, [200]);
    return sessionOf(body, `GET ${path}`);
  };

  const listRuns = async (sessionId: string): Promise<RunView[]> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}/runs`;
    const { body } = await send('GET', path, [200]);
    return listOf(body, 'runs', `GET ${path}`).map((entry) => checkRun(entry, `GET ${path}`));
  };

  const skills = async (sessionId: string): Promise<SkillsResponse> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}/skills`;
    const { body } = await send('GET', path, [200]);
    return checkSkills(body, `GET ${path}`);
  };

  const agents = async (sessionId: string): Promise<AgentsResponse> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}/agents`;
    const { body } = await send('GET', path, [200]);
    return checkAgents(body, `GET ${path}`);
  };

  const jobs = async (sessionId: string): Promise<JobView[]> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}/jobs`;
    const { body } = await send('GET', path, [200]);
    return checkJobs(body, `GET ${path}`).jobs;
  };

  const childRuns = async (runId: string): Promise<RunView[]> => {
    const path = `/v1/runs/${pathSegment(runId)}/children`;
    const { body } = await send('GET', path, [200]);
    return listOf(body, 'runs', `GET ${path}`).map((entry) => checkRun(entry, `GET ${path}`));
  };

  const setMcpServers = async (sessionId: string, servers: Readonly<Record<string, McpServerConfig>>): Promise<SessionView> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}`;
    const { body } = await send('PATCH', path, [200], { body: { mcpServers: servers } });
    return sessionOf(body, `PATCH ${path}`);
  };

  const listSessions = async (cwd?: string): Promise<SessionView[]> => {
    const description = 'GET /v1/sessions';
    const { body } = await send('GET', cwd === undefined ? '/v1/sessions' : `/v1/sessions?cwd=${encodeURIComponent(cwd)}`, [200]);
    return listOf(body, 'sessions', description).map((entry) => checkSession(entry, description));
  };

  const setPermissionMode = async (sessionId: string, mode: PermissionMode): Promise<SessionView> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}`;
    const { body } = await send('PATCH', path, [200], { body: { permissionMode: mode } });
    return sessionOf(body, `PATCH ${path}`);
  };

  const setModel = async (sessionId: string, model: string): Promise<SessionView> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}`;
    const { body } = await send('PATCH', path, [200], { body: { model } });
    return sessionOf(body, `PATCH ${path}`);
  };

  const createRun = async (sessionId: string, input: string, runOptions: CreateRunOptions = {}): Promise<{ run: RunView; location: string }> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}/runs`;
    const { response, body } = await send('POST', path, [202], {
      body: createRunBody(input, runOptions),
      ...(runOptions.idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': runOptions.idempotencyKey } }),
    });
    const location = response.headers['location'];
    if (location === undefined) throw new ContractViolation(`POST ${path}`, 'no Location header');
    return { run: runOf(body, `POST ${path}`), location };
  };

  const compact = async (sessionId: string, instructions?: string): Promise<RunView> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}/compact`;
    const { body } = await send('POST', path, [202], { body: instructions === undefined ? {} : { instructions } });
    return runOf(body, `POST ${path}`);
  };

  const getRun = async (id: string): Promise<RunView> => {
    const path = `/v1/runs/${pathSegment(id)}`;
    const { body } = await send('GET', path, [200]);
    return runOf(body, `GET ${path}`);
  };

  const inboxAdd = async (sessionId: string, delivery: InboxDelivery, text: string, images: readonly ImageAttachment[] = []): Promise<InboxAddResponse> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}/inbox`;
    const { body } = await send('POST', path, [201], { body: { delivery, text, ...(images.length === 0 ? {} : { images }) } });
    return checkInboxAdd(body, `POST ${path}`);
  };

  const inboxWithdraw = async (id: string): Promise<InboxWithdrawResponse> => {
    const path = `/v1/inbox/${pathSegment(id)}/withdraw`;
    const { body } = await send('POST', path, [200]);
    return checkInboxWithdraw(body, `POST ${path}`);
  };

  const inboxList = async (sessionId: string): Promise<InboxRowView[]> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}/inbox`;
    const { body } = await send('GET', path, [200]);
    return checkInbox(body, `GET ${path}`).pending;
  };

  const runSuccessor = async (runId: string): Promise<RunView | undefined> => {
    const path = `/v1/runs/${pathSegment(runId)}/successor`;
    const { body } = await send('GET', path, [200]);
    const { successor } = checkRunSuccessor(body, `GET ${path}`);
    return successor === null ? undefined : successor;
  };

  const cancel = async (id: string): Promise<{ status: 200 | 202; run: RunView }> => {
    const path = `/v1/runs/${pathSegment(id)}/cancel`;
    const { response, body } = await send('POST', path, [200, 202]);
    return { status: response.status === 200 ? 200 : 202, run: runOf(body, `POST ${path}`) };
  };

  const trace = async (runId: string): Promise<RunTraceView> => {
    const path = `/v1/runs/${pathSegment(runId)}/trace`;
    const { body } = await send('GET', path, [200]);
    return checkTrace(body, `GET ${path}`);
  };

  const approvals = async (runId: string): Promise<ApprovalView[]> => {
    const path = `/v1/runs/${pathSegment(runId)}/approvals`;
    const { body } = await send('GET', path, [200]);
    return listOf(body, 'approvals', `GET ${path}`).map((entry) => checkApproval(entry, `GET ${path}`));
  };

  const getApproval = async (id: string): Promise<ApprovalView> => {
    const path = `/v1/approvals/${pathSegment(id)}`;
    const { body } = await send('GET', path, [200]);
    return checkApproval(fieldOf(body, 'approval', `GET ${path}`), `GET ${path}`);
  };

  const resolveApproval = async (id: string, optionId: string): Promise<ResolvedApproval> => {
    const path = `/v1/approvals/${pathSegment(id)}`;
    const { body } = await send('POST', path, [200], { body: { optionId } });
    return { approval: checkApproval(fieldOf(body, 'approval', `POST ${path}`), `POST ${path}`), run: runOf(body, `POST ${path}`) };
  };

  const elicitations = async (runId: string): Promise<ElicitationView[]> => {
    const path = `/v1/runs/${pathSegment(runId)}/elicitations`;
    const { body } = await send('GET', path, [200]);
    return listOf(body, 'elicitations', `GET ${path}`).map((entry) => checkElicitation(entry, `GET ${path}`));
  };

  const getElicitation = async (id: string): Promise<ElicitationView> => {
    const path = `/v1/elicitations/${pathSegment(id)}`;
    const { body } = await send('GET', path, [200]);
    return checkElicitation(fieldOf(body, 'elicitation', `GET ${path}`), `GET ${path}`);
  };

  const resolveElicitation = async (id: string, responses: Readonly<Record<string, ElicitationAnswerRecord>>): Promise<ResolvedElicitation> => {
    const path = `/v1/elicitations/${pathSegment(id)}`;
    const { body } = await send('POST', path, [200], { body: { responses } });
    return { elicitation: checkElicitation(fieldOf(body, 'elicitation', `POST ${path}`), `POST ${path}`), run: runOf(body, `POST ${path}`) };
  };

  const mcpServers = async (sessionId: string): Promise<McpServerView[]> => {
    const path = `/v1/sessions/${pathSegment(sessionId)}/mcp/servers`;
    const { body } = await send('GET', path, [200]);
    return checkMcpServers(body, `GET ${path}`).servers;
  };

  const authorizationPath = (sessionId: string, server: string): string => `/v1/sessions/${pathSegment(sessionId)}/mcp/servers/${pathSegment(server)}/authorization`;

  const startMcpAuthorization = async (sessionId: string, server: string): Promise<McpAuthorizationView> => {
    const path = authorizationPath(sessionId, server);
    const { body } = await send('POST', path, [202]);
    return checkMcpAuthorization(fieldOf(body, 'authorization', `POST ${path}`), `POST ${path}`);
  };

  const mcpAuthorization = async (sessionId: string, server: string): Promise<McpAuthorizationView> => {
    const path = authorizationPath(sessionId, server);
    const { body } = await send('GET', path, [200]);
    return checkMcpAuthorization(fieldOf(body, 'authorization', `GET ${path}`), `GET ${path}`);
  };

  const cancelMcpAuthorization = async (sessionId: string, server: string): Promise<void> => {
    await send('DELETE', authorizationPath(sessionId, server), [204]);
  };

  const memoriesQueryOf = (filter: MemoryFilter, after?: string): string => {
    const query = new URLSearchParams();
    if (after !== undefined) query.set('after', after);
    if (filter.scope !== undefined) query.set('scope', filter.scope);
    if (filter.state !== undefined) query.set('state', filter.state);
    if (filter.project !== undefined) query.set('project', filter.project);
    const text = query.toString();
    return text === '' ? '' : `?${text}`;
  };

  const memories = async (filter: MemoryFilter = {}): Promise<MemoryView[]> => {
    const found: MemoryView[] = [];
    let after: string | undefined;
    do {
      const path = `/v1/memories${memoriesQueryOf(filter, after)}`;
      const { body } = await send('GET', path, [200]);
      const page = checkMemories(body, `GET ${path}`);
      found.push(...page.memories);
      after = page.next ?? undefined;
    } while (after !== undefined);
    return found;
  };

  const lastReflection = async (project: string): Promise<ReflectionJobView | null> => {
    const path = `/v1/reflection?project=${encodeURIComponent(project)}`;
    const { body } = await send('GET', path, [200]);
    return checkReflection(body, `GET ${path}`).job;
  };

  const runAnsweredBy = async (runId: string): Promise<RunAnsweredByView> => {
    const path = `/v1/runs/${pathSegment(runId)}/answered-by`;
    const { body } = await send('GET', path, [200]);
    return checkRunAnsweredBy(body, `GET ${path}`);
  };

  const runReflection = async (runId: string): Promise<RunReflectionView> => {
    const path = `/v1/runs/${pathSegment(runId)}/reflection`;
    const { body } = await send('GET', path, [200]);
    return checkRunReflection(body, `GET ${path}`);
  };

  const memory = async (id: string): Promise<MemoryView> => {
    const path = `/v1/memories/${pathSegment(id)}`;
    const { body } = await send('GET', path, [200]);
    return checkMemory(body, `GET ${path}`).memory;
  };

  const addMemory = async (request: AddMemoryRequest): Promise<MemoryView> => {
    const { body } = await send('POST', '/v1/memories', [201], { body: request });
    return checkMemory(body, 'POST /v1/memories').memory;
  };

  const deleteMemory = async (id: string): Promise<void> => {
    await send('DELETE', `/v1/memories/${pathSegment(id)}`, [204]);
  };

  const memoryHistory = async (id: string): Promise<MemoryView[]> => {
    const path = `/v1/memories/${pathSegment(id)}/history`;
    const { body } = await send('GET', path, [200]);
    return checkMemories(body, `GET ${path}`).memories;
  };

  const changeMemory = (action: 'accept' | 'reject' | 'restore') => async (id: string): Promise<MemoryView> => {
    const path = `/v1/memories/${pathSegment(id)}/${action}`;
    const { body } = await send('POST', path, [200]);
    return checkMemory(body, `POST ${path}`).memory;
  };

  const promoteMemory = async (id: string, skill: string): Promise<string> => {
    const path = `/v1/memories/${pathSegment(id)}/promote`;
    const { body } = await send('POST', path, [201], { body: { skill } });
    return checkPromoted(body, `POST ${path}`).path;
  };

  const rules = async (project: string): Promise<GoverningFactView[]> => {
    const path = `/v1/rules?project=${encodeURIComponent(project)}`;
    const { body } = await send('GET', path, [200]);
    return checkRules(body, `GET ${path}`).facts;
  };

  const addRule = async (request: AddRuleRequest): Promise<RuleAddResponse> => {
    const { body } = await send('POST', '/v1/rules', [201], { body: request });
    return checkRuleAdd(body, 'POST /v1/rules');
  };

  const retireRule = async (id: string): Promise<GoverningFactView> => {
    const path = `/v1/rules/${pathSegment(id)}/retire`;
    const { body } = await send('POST', path, [200]);
    return checkRule(body, `POST ${path}`).fact;
  };

  const ignoreMarker = async (name: string): Promise<void> => {
    await send('POST', `/v1/markers/${pathSegment(name)}/ignore`, [204]);
  };

  const ruleHistory = async (id: string): Promise<GoverningFactView[]> => {
    const path = `/v1/rules/${pathSegment(id)}/history`;
    const { body } = await send('GET', path, [200]);
    return checkRules(body, `GET ${path}`).facts;
  };

  const policyGovernance = async (project: string): Promise<PolicyGovernanceResponse> => {
    const path = `/v1/policy/governance?project=${encodeURIComponent(project)}`;
    const { body } = await send('GET', path, [200]);
    return checkPolicyGovernance(body, `GET ${path}`);
  };

  const putRuleVerdict = async (fingerprint: string, verdict: RuleVerdict): Promise<void> => {
    await send('PUT', `/v1/policy/verdicts/${pathSegment(fingerprint)}`, [204], { body: { verdict } satisfies PutRuleVerdictRequest });
  };

  const costPath = (filter: CostFilter, format: 'json' | 'text'): string => `/v1/cost?${new URLSearchParams({ ...filter, format }).toString()}`;

  const guidelines = async (): Promise<GuidelinesResponse> => {
    const { body } = await send('GET', '/v1/guidelines', [200]);
    return checkGuidelines(body, 'GET /v1/guidelines');
  };

  const adoptGuideline = async (request: AdoptGuidelineRequest): Promise<GuidelineView> => {
    const { body } = await send('POST', '/v1/guidelines', [201], { body: request });
    return checkGuideline(body, 'POST /v1/guidelines').guideline;
  };

  const rollbackGuideline = async (version: number): Promise<GuidelineView> => {
    const path = `/v1/guidelines/${version}/rollback`;
    const { body } = await send('POST', path, [201]);
    return checkGuideline(body, `POST ${path}`).guideline;
  };

  const recordContextCharge = async (request: RecordContextChargeRequest): Promise<ContextChargeView> => {
    const { body } = await send('POST', '/v1/context-charges', [201], { body: request });
    return checkContextCharge(body, 'POST /v1/context-charges').charge;
  };

  const reportFacts = async (request: { cursor: string | null; limit: number }): Promise<ReportPage> => {
    const query = new URLSearchParams({ limit: String(request.limit), ...(request.cursor === null ? {} : { cursor: request.cursor }) });
    const path = `/v1/report/facts?${query.toString()}`;
    const { body } = await send('GET', path, [200]);
    return checkReportPage(body, `GET ${path}`);
  };

  const reportReviews = async (request: { cursor: string | null; limit: number }): Promise<ReviewPage> => {
    const query = new URLSearchParams({ limit: String(request.limit), ...(request.cursor === null ? {} : { cursor: request.cursor }) });
    const path = `/v1/report/reviews?${query.toString()}`;
    const { body } = await send('GET', path, [200]);
    return checkReviewPage(body, `GET ${path}`);
  };

  const storeReview = async (request: StoreReviewRequest): Promise<PermissionReviewView> => {
    const { body } = await send('POST', '/v1/report/reviews', [201], { body: request });
    return checkStoreReview(body, 'POST /v1/report/reviews').review;
  };

  const reportCost = async (runIds: readonly string[]): Promise<RunCostView[]> => {
    const { body } = await send('POST', '/v1/report/cost', [200], { body: { runIds } });
    return checkReportCost(body, 'POST /v1/report/cost').costs;
  };

  const traceContent = async (runId: string, request: { after: number; limit: number }): Promise<TraceContentPage> => {
    const path = `/v1/runs/${pathSegment(runId)}/trace/content?${new URLSearchParams({ after: String(request.after), limit: String(request.limit) }).toString()}`;
    const { body } = await send('GET', path, [200]);
    return checkTraceContent(body, `GET ${path}`);
  };

  const cost = async (filter: CostFilter = {}): Promise<CostReportView> => {
    const path = costPath(filter, 'json');
    const { body } = await send('GET', path, [200]);
    return checkCostReport(body, `GET ${path}`);
  };

  const costText = async (filter: CostFilter = {}): Promise<string> => {
    const { body } = await send('GET', costPath(filter, 'text'), [200], { raw: true });
    if (typeof body !== 'string') throw new ContractViolation('GET /v1/cost', 'the text report is not text');
    return body;
  };

  const breakdownPath = (filter: CostFilter, format: 'json' | 'text'): string =>
    `/v1/cost?${new URLSearchParams({ ...filter, format, breakdown: '1' }).toString()}`;

  const costBreakdown = async (filter: CostFilter = {}): Promise<CostBreakdownView> => {
    const path = breakdownPath(filter, 'json');
    const { body } = await send('GET', path, [200]);
    return checkCostBreakdown(body, `GET ${path}`);
  };

  const costBreakdownText = async (filter: CostFilter = {}): Promise<string> => {
    const path = breakdownPath(filter, 'text');
    const { body } = await send('GET', path, [200], { raw: true });
    if (typeof body !== 'string') throw new ContractViolation(`GET ${path}`, 'the text breakdown is not text');
    return body;
  };

  const trust = async (path: string): Promise<TrustView> => {
    const description = 'GET /v1/trust';
    const { body } = await send('GET', `/v1/trust?path=${encodeURIComponent(path)}`, [200]);
    return checkTrust(fieldOf(body, 'trust', description), description);
  };

  const setTrust = async (path: string, decision: 'trusted' | 'untrusted'): Promise<TrustView> => {
    const description = 'PUT /v1/trust';
    const { body } = await send('PUT', '/v1/trust', [200], { body: { path, decision } });
    return checkTrust(fieldOf(body, 'trust', description), description);
  };

  async function* openEventStream(path: string, eventsOptions: EventsOptions): AsyncGenerator<RunEventFrame> {
    const description = `GET ${path}`;
    const response = await http.request({
      method: 'GET',
      path: `${path}${eventsQueryOf(eventsOptions)}`,
      headers: eventsHeadersOf(eventsOptions),
      ...(eventsOptions.signal === undefined ? {} : { signal: eventsOptions.signal }),
    });
    if (response.status !== 200) throw new RunApiError(description, response.status, await response.text());
    eventsOptions.onOpen?.();
    for await (const event of decodeSse(response.body)) yield frameOf(event, description);
  }

  async function* streamEvents(runId: string, eventsOptions: EventsOptions = {}): AsyncGenerator<RunEventFrame> {
    yield* openEventStream(`/v1/runs/${pathSegment(runId)}/events`, eventsOptions);
  }

  async function* streamSessionEvents(sessionId: string, eventsOptions: EventsOptions = {}): AsyncGenerator<RunEventFrame> {
    yield* openEventStream(`/v1/sessions/${pathSegment(sessionId)}/events`, eventsOptions);
  }

  return {
    health,
    createSession,
    getSession,
    listSessions,
    listRuns,
    skills,
    agents,
    jobs,
    childRuns,
    setMcpServers,
    setPermissionMode,
    setModel,
    createRun,
    compact,
    inboxAdd,
    inboxWithdraw,
    inboxList,
    userShell: async (sessionId, command, include, onOutput) => {
      const path = `/v1/sessions/${pathSegment(sessionId)}/user-shell`;
      const description = `POST ${path}`;
      const response = await http.request({ method: 'POST', path, headers: JSON_HEADERS, body: JSON.stringify({ command, include }) });
      if (response.status !== 200) throw new RunApiError(description, response.status, await response.text());
      for await (const event of decodeSse(response.body)) {
        const frame = checkUserShellFrame(parsed(event.data, description), description);
        if (frame.type === 'output') onOutput(frame.text);
        else return frame.type === 'refused' ? { kind: 'refused', reason: frame.reason } : { kind: 'exit', record: frame.record };
      }
      throw new ContractViolation(description, 'the stream ended without an exit');
    },
    stopUserShell: async (sessionId) => {
      await send('DELETE', `/v1/sessions/${pathSegment(sessionId)}/user-shell`, [200]);
    },
    pendingUserShell: async (sessionId) => {
      const path = `/v1/sessions/${pathSegment(sessionId)}/user-shell`;
      const { body } = await send('GET', path, [200]);
      return checkUserShellPending(body, `GET ${path}`).pending;
    },
    runSuccessor,
    getRun,
    cancel,
    trace,
    approvals,
    getApproval,
    resolveApproval,
    elicitations,
    getElicitation,
    resolveElicitation,
    mcpServers,
    startMcpAuthorization,
    mcpAuthorization,
    cancelMcpAuthorization,
    memories,
    lastReflection,
    runReflection,
    runAnsweredBy,
    memory,
    addMemory,
    deleteMemory,
    memoryHistory,
    acceptMemory: changeMemory('accept'),
    rejectMemory: changeMemory('reject'),
    restoreMemory: changeMemory('restore'),
    promoteMemory,
    rules,
    addRule,
    retireRule,
    ruleHistory,
    ignoreMarker,
    policyGovernance,
    putRuleVerdict,
    guidelines,
    adoptGuideline,
    rollbackGuideline,
    recordContextCharge,
    reportFacts,
    reportReviews,
    storeReview,
    reportCost,
    traceContent,
    cost,
    costText,
    costBreakdown,
    costBreakdownText,
    trust,
    setTrust,
    streamEvents,
    streamSessionEvents,
    close: () => http.close(),
  };
};
