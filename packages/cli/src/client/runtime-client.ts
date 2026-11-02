import { createUdsClient, decodeSse, isRecord } from '@momonga/foundation';
import type { UdsResponse } from '@momonga/foundation';
import type { PermissionMode, PublicRunEvent, RunHealth, RunTraceView } from '@momonga/protocol';
import { ContractViolation, checkApproval, checkTrace, checkErrorBody, checkHealth, checkRun, checkRunEvent, checkSession, checkTrust } from './contract.ts';
import type { ApprovalView, RunView, SessionView, TrustView } from './views.ts';

export class RunApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly code: string | undefined;

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
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

export type RunEventFrame = { readonly id: number; readonly event: string | undefined; readonly data: PublicRunEvent };

export type EventsOptions = { after?: number; lastEventId?: number; signal?: AbortSignal };

export type CreateSessionInput = {
  cwd: string;
  env: Readonly<Record<string, string>>;
  permissionMode?: PermissionMode;
  modelAlias?: string;
  bypassAllowed?: boolean;
};

export type CreateRunOptions = { history?: 'inherit' | 'fresh'; idempotencyKey?: string };

export type CreatedSession = { session: SessionView; strippedEnvKeys: string[] };

export type ResolvedApproval = { approval: ApprovalView; run: RunView };

export type RuntimeClient = {
  health(): Promise<RunHealth>;
  createSession(input: CreateSessionInput): Promise<CreatedSession>;
  listSessions(cwd: string): Promise<SessionView[]>;
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionView>;
  createRun(sessionId: string, input: string, options?: CreateRunOptions): Promise<{ run: RunView; location: string }>;
  getRun(id: string): Promise<RunView>;
  cancel(id: string): Promise<{ status: 200 | 202; run: RunView }>;
  trace(runId: string): Promise<RunTraceView>;
  approvals(runId: string): Promise<ApprovalView[]>;
  getApproval(id: string): Promise<ApprovalView>;
  resolveApproval(id: string, optionId: string): Promise<ResolvedApproval>;
  trust(path: string): Promise<TrustView>;
  setTrust(path: string, decision: 'trusted' | 'untrusted'): Promise<TrustView>;
  streamEvents(runId: string, options?: EventsOptions): AsyncGenerator<RunEventFrame>;
  close(): Promise<void>;
};

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export const eventsQueryOf = (options: EventsOptions): string => (options.after === undefined ? '' : `?after=${options.after}`);

export const eventsHeadersOf = (options: EventsOptions): Record<string, string> => ({
  accept: 'text/event-stream',
  ...(options.lastEventId === undefined ? {} : { 'last-event-id': String(options.lastEventId) }),
});

export const createRunBody = (input: string, options: CreateRunOptions = {}): { input: string; history?: 'inherit' | 'fresh' } => ({
  input,
  ...(options.history === undefined ? {} : { history: options.history }),
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

const frameOf = (event: { id?: string; event?: string; data: string }, description: string): RunEventFrame => {
  if (event.id === undefined) throw new ContractViolation(description, `an event without an id: ${event.data}`);
  const id = Number(event.id);
  if (!Number.isInteger(id)) throw new ContractViolation(description, `an event with a non-integer id ${event.id}`);
  return { id, event: event.event, data: checkRunEvent(parsed(event.data, description), description) };
};

export const createRuntimeClient = (options: { socketPath: string }): RuntimeClient => {
  const http = createUdsClient(options.socketPath);

  const send = async (
    method: string,
    path: string,
    expected: readonly number[],
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ response: UdsResponse; body: unknown }> => {
    const description = `${method} ${path}`;
    const headers = { ...(init.body === undefined ? {} : JSON_HEADERS), ...init.headers };
    const response = await http.request({
      method,
      path,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    if (!expected.includes(response.status)) throw new RunApiError(description, response.status, text);
    return { response, body: parsed(text, description) };
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
        ...(input.modelAlias === undefined ? {} : { modelAlias: input.modelAlias }),
        ...(input.bypassAllowed === undefined ? {} : { bypassAllowed: input.bypassAllowed }),
      },
    });
    const stripped = listOf(body, 'strippedEnvKeys', description);
    if (!stripped.every((key): key is string => typeof key === 'string')) throw new ContractViolation(description, 'strippedEnvKeys holds a non-string');
    return { session: sessionOf(body, description), strippedEnvKeys: stripped };
  };

  const listSessions = async (cwd: string): Promise<SessionView[]> => {
    const description = 'GET /v1/sessions';
    const { body } = await send('GET', `/v1/sessions?cwd=${encodeURIComponent(cwd)}`, [200]);
    return listOf(body, 'sessions', description).map((entry) => checkSession(entry, description));
  };

  const setPermissionMode = async (sessionId: string, mode: PermissionMode): Promise<SessionView> => {
    const path = `/v1/sessions/${sessionId}`;
    const { body } = await send('PATCH', path, [200], { body: { permissionMode: mode } });
    return sessionOf(body, `PATCH ${path}`);
  };

  const createRun = async (sessionId: string, input: string, runOptions: CreateRunOptions = {}): Promise<{ run: RunView; location: string }> => {
    const path = `/v1/sessions/${sessionId}/runs`;
    const { response, body } = await send('POST', path, [202], {
      body: createRunBody(input, runOptions),
      ...(runOptions.idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': runOptions.idempotencyKey } }),
    });
    const location = response.headers['location'];
    if (location === undefined) throw new ContractViolation(`POST ${path}`, 'no Location header');
    return { run: runOf(body, `POST ${path}`), location };
  };

  const getRun = async (id: string): Promise<RunView> => {
    const path = `/v1/runs/${id}`;
    const { body } = await send('GET', path, [200]);
    return runOf(body, `GET ${path}`);
  };

  const cancel = async (id: string): Promise<{ status: 200 | 202; run: RunView }> => {
    const path = `/v1/runs/${id}/cancel`;
    const { response, body } = await send('POST', path, [200, 202]);
    return { status: response.status === 200 ? 200 : 202, run: runOf(body, `POST ${path}`) };
  };

  const trace = async (runId: string): Promise<RunTraceView> => {
    const path = `/v1/runs/${runId}/trace`;
    const { body } = await send('GET', path, [200]);
    return checkTrace(body, `GET ${path}`);
  };

  const approvals = async (runId: string): Promise<ApprovalView[]> => {
    const path = `/v1/runs/${runId}/approvals`;
    const { body } = await send('GET', path, [200]);
    return listOf(body, 'approvals', `GET ${path}`).map((entry) => checkApproval(entry, `GET ${path}`));
  };

  const getApproval = async (id: string): Promise<ApprovalView> => {
    const path = `/v1/approvals/${id}`;
    const { body } = await send('GET', path, [200]);
    return checkApproval(fieldOf(body, 'approval', `GET ${path}`), `GET ${path}`);
  };

  const resolveApproval = async (id: string, optionId: string): Promise<ResolvedApproval> => {
    const path = `/v1/approvals/${id}`;
    const { body } = await send('POST', path, [200], { body: { optionId } });
    return { approval: checkApproval(fieldOf(body, 'approval', `POST ${path}`), `POST ${path}`), run: runOf(body, `POST ${path}`) };
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

  async function* streamEvents(runId: string, eventsOptions: EventsOptions = {}): AsyncGenerator<RunEventFrame> {
    const path = `/v1/runs/${runId}/events${eventsQueryOf(eventsOptions)}`;
    const description = `GET /v1/runs/${runId}/events`;
    const response = await http.request({
      method: 'GET',
      path,
      headers: eventsHeadersOf(eventsOptions),
      ...(eventsOptions.signal === undefined ? {} : { signal: eventsOptions.signal }),
    });
    if (response.status !== 200) throw new RunApiError(description, response.status, await response.text());
    for await (const event of decodeSse(response.body)) yield frameOf(event, description);
  }

  return {
    health,
    createSession,
    listSessions,
    setPermissionMode,
    createRun,
    getRun,
    cancel,
    trace,
    approvals,
    getApproval,
    resolveApproval,
    trust,
    setTrust,
    streamEvents,
    close: () => http.close(),
  };
};
