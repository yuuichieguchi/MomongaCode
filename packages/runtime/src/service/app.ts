import path from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { ConfigError, stripCredentialEnv } from '@momonga/config';
import { canonicalDirectory, canonicalJson, canonicalPath, comparableContains, comparablePath, isTransientErrno, sha256Hex } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { AUTO_MODE_UNAVAILABLE, RUN_STATUSES, isUnavailableMode } from '@momonga/protocol';
import type { Capabilities, CostReportView, PermissionMode, RunStatus, RunTraceView } from '@momonga/protocol';
import { SkillActivationError, UnknownSkillError } from '@momonga/skills';
import { sameRunRequest } from '@momonga/store';
import type { Run, RuntimeStore, Session } from '@momonga/store';
import { GatewayRequestError } from '../gateway-client.ts';
import type { SkillsPort } from '../ports.ts';
import type { SandboxKind } from '../process/sandbox-kind.ts';
import {
  ApiError,
  conflict,
  configError,
  errorResponse,
  imageInputUnsupported,
  idempotencyKeyReused,
  internalErrorResponse,
  invalidRequest,
  methodNotAllowed,
  modeNotAllowed,
  notFound,
  serviceUnavailable,
  skillUnavailable,
  unknownSkill,
} from './errors.ts';
import { STREAM_HEADERS, eventStreamResponse } from './event-stream.ts';
import type { EventSource } from './event-stream.ts';
import type { RunNotifier } from './notifier.ts';
import { JSON_MEDIA_TYPES, PATCH_MEDIA_TYPES, parseCursor, parseIdempotencyKey, readJson, validateBody } from './request.ts';
import type { CreateRunBody, CreateSessionBody, PatchSessionBody, ResolveApprovalBody } from './request.ts';
import { registerMemoryRoutes } from './memories.ts';
import { registerInputRoutes } from './input-routes.ts';
import type { McpAdminPort } from './input-routes.ts';
import { registerTrustRoutes } from './trust.ts';
import type { ServiceTimers } from './timers.ts';
import { isTerminalStatus, toRunView, toSessionView, toSkillView } from './views.ts';

export type RunLimitDefaults = { maxSteps: number; maxTotalTokens: number; approvalTtlMs: number; loopThreshold: number };

export type RunServiceDefaults = { modelAlias: string; runTimeoutMs: number; limits: RunLimitDefaults };

export type SessionCreateSettings = {
  defaultMode?: PermissionMode;
  defaultModeOrigin?: 'user' | 'project' | 'local';
  additionalDirectories: readonly string[];
  credentialEnvNames: readonly string[];
};

export type RunAppDeps = {
  store: RuntimeStore;
  clock: Clock;
  version: string;
  modelAliases: () => Promise<readonly string[]>;
  modelCapabilities: (alias: string, signal: AbortSignal) => Promise<Capabilities>;
  sessionCreateSettings: (cwd: string) => Promise<SessionCreateSettings>;
  skills: SkillsPort;
  isDraining(): boolean;
  health: { pid: number; startedAt: string; sandbox: SandboxKind };
  protectedRootAreas: readonly string[];
  defaults: RunServiceDefaults;
  notifier: RunNotifier;
  timers: ServiceTimers;
  keepAliveMs: number;
  maxBodyBytes: number;
  closeSignal: AbortSignal;
  cancelUpstream?: (runId: string) => Promise<void>;
  runTrace: (runId: string) => Promise<RunTraceView | undefined>;
  runCost: (runs: readonly { runId: string; sessionId: string }[], signal: AbortSignal) => Promise<{ report: CostReportView; text: string }>;
  mcp: McpAdminPort;
  onError: (error: unknown) => void;
};

export type Handler = (context: Context) => Response | Promise<Response>;

export type RouteRegistrar = (routePath: string, handlers: Readonly<Record<string, Handler>>) => void;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const requireAbsolute = (value: string, label: string): void => {
  if (!path.isAbsolute(value)) throw invalidRequest(`${label} must be an absolute path`, label);
};

const protectedAreaOf = (areas: readonly string[], target: string): string | undefined =>
  areas.find((area) => comparableContains(area, target));

const isGatewayUnavailable = (error: unknown): boolean =>
  error instanceof GatewayRequestError && (error.type === 'transport' || error.status >= 500);

const checkModeAllowed = (mode: PermissionMode, bypassAllowed: boolean): void => {
  if (isUnavailableMode(mode)) throw conflict(AUTO_MODE_UNAVAILABLE.code, AUTO_MODE_UNAVAILABLE.message);
  if (mode === 'bypassPermissions' && !bypassAllowed) {
    throw modeNotAllowed('this session may not use the bypassPermissions mode');
  }
};

const parseStatusFilter = (raw: string | null): RunStatus[] | undefined => {
  if (raw === null) return undefined;
  const statuses = raw.split(',');
  for (const status of statuses) {
    if (!(RUN_STATUSES as readonly string[]).includes(status)) throw invalidRequest(`unknown run status ${JSON.stringify(status)}`, 'status');
  }
  return statuses as RunStatus[];
};

export const createRunApp = (deps: RunAppDeps): Hono => {
  const { store, notifier } = deps;
  const app = new Hono();

  const requireSession = (id: string) => {
    const session = store.getSession(id);
    if (session === undefined) throw notFound(`session ${id} does not exist`);
    return session;
  };

  const requireRun = (id: string): Run => {
    const run = store.getRun(id);
    if (run === undefined) throw notFound(`run ${id} does not exist`);
    return run;
  };

  const route: RouteRegistrar = (routePath: string, handlers: Readonly<Record<string, Handler>>): void => {
    app.all(routePath, (context) => {
      const method = context.req.method;
      const handler = method === 'HEAD' ? handlers['GET'] : handlers[method];
      if (handler === undefined) throw methodNotAllowed(handlers['GET'] === undefined ? Object.keys(handlers) : [...Object.keys(handlers), 'HEAD']);
      return handler(context);
    });
  };

  const health: Handler = () =>
  json({
    status: 'ok',
    version: deps.version,
    apiVersion: 1,
    pid: deps.health.pid,
    startedAt: deps.health.startedAt,
    state: deps.isDraining() ? 'draining' : 'running',
    sandbox: deps.health.sandbox,
  });

  const drainingError = () => serviceUnavailable('draining', 'the service is draining and accepts no new work');

  const createSession: Handler = async (context) => {
    if (deps.isDraining()) throw drainingError();
    const body = validateBody<CreateSessionBody>('CreateSessionRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const resolved = canonicalDirectory(body.cwd);
    if (!resolved.ok) throw invalidRequest(`cwd ${body.cwd} ${resolved.reason}`, 'cwd');
    const cwd = resolved.path;
    const cwdArea = protectedAreaOf(deps.protectedRootAreas, cwd);
    if (cwdArea !== undefined) throw invalidRequest(`cwd ${body.cwd} is inside ${cwdArea} and cannot be a session root`, 'cwd');
    const modelAlias = body.modelAlias ?? deps.defaults.modelAlias;
    let aliases: readonly string[];
    try {
      aliases = await deps.modelAliases();
    } catch (error) {
      if (isGatewayUnavailable(error)) throw serviceUnavailable('gateway_unavailable', 'the model gateway is unavailable');
      throw error;
    }
    if (!aliases.includes(modelAlias)) throw invalidRequest(`unknown model alias ${modelAlias}`, 'modelAlias');
    let settings: SessionCreateSettings;
    try {
      settings = await deps.sessionCreateSettings(cwd);
    } catch (error) {
      if (error instanceof ConfigError) throw configError(error.message);
      throw error;
    }
    const additionalDirectories: string[] = [];
    const seen = new Set<string>([comparablePath(cwd)]);
    for (const entry of settings.additionalDirectories) {
      const area = protectedAreaOf(deps.protectedRootAreas, entry);
      if (area !== undefined) {
        throw configError(`additionalDirectories entry ${entry} is inside ${area} and cannot be a session root`, 'additionalDirectories');
      }
      const key = comparablePath(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      additionalDirectories.push(entry);
    }
    const permissionMode = body.permissionMode ?? settings.defaultMode ?? 'default';
    const bypassAllowed =
      body.bypassAllowed === true || (settings.defaultMode === 'bypassPermissions' && settings.defaultModeOrigin === 'user');
    checkModeAllowed(permissionMode, bypassAllowed);
    const stripped = stripCredentialEnv(body.env, settings.credentialEnvNames);
    const session = store.createSession({ cwd, env: stripped.env, permissionMode, modelAlias, bypassAllowed, additionalDirectories });
    return json({ session: toSessionView(store, session), strippedEnvKeys: stripped.removed }, 201, { location: `/v1/sessions/${session.id}` });
  };

  const listSessions: Handler = (context) => {
    const requested = context.req.query('cwd');
    if (requested === undefined) return json({ sessions: store.listSessions().map((session) => toSessionView(store, session)) });
    requireAbsolute(requested, 'cwd');
    let cwd: string;
    try {
      cwd = canonicalPath(requested);
    } catch (error) {
      if (isTransientErrno(error)) throw error;
      throw invalidRequest(`cwd ${requested} cannot be resolved: ${(error as Error).message}`, 'cwd');
    }
    return json({ sessions: store.listSessions({ cwd }).map((session) => toSessionView(store, session)) });
  };

  const getSession: Handler = (context) => json({ session: toSessionView(store, requireSession(context.req.param('id') ?? '')) });

  const patchSession: Handler = async (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    const body = validateBody<PatchSessionBody>('PatchSessionRequest', await readJson(context.req.raw, PATCH_MEDIA_TYPES, deps.maxBodyBytes));
    checkModeAllowed(body.permissionMode, session.bypassAllowed);
    const result = store.setPermissionMode(session.id, body.permissionMode);
    if (result.kind === 'not_found') throw notFound(`session ${session.id} does not exist`);
    return json({ session: toSessionView(store, result.session) });
  };

  const listRuns: Handler = (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    const statuses = parseStatusFilter(context.req.query('status') ?? null);
    return json({ runs: store.listRuns(session.id, statuses).map(toRunView) });
  };

  const activationOf = async (session: Session, name: string) => {
    const skills = await deps.skills.load(session);
    try {
      return await skills.activate(name);
    } catch (error) {
      if (error instanceof UnknownSkillError) throw unknownSkill(error.message);
      if (error instanceof SkillActivationError) throw skillUnavailable(error.message);
      throw error;
    }
  };

  const listSkills: Handler = async (context) => {
    const skills = await deps.skills.load(requireSession(context.req.param('id') ?? ''));
    return json({ skills: skills.skills.map(toSkillView), warnings: [...skills.warnings] });
  };

  const createRun: Handler = async (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    const idempotencyKey = parseIdempotencyKey(context.req.header('idempotency-key') ?? null);
    const parsed = await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes);
    const body = validateBody<CreateRunBody>('CreateRunRequest', parsed);
    const idempotency = idempotencyKey === undefined ? undefined : { idempotencyKey, requestDigest: sha256Hex(canonicalJson(parsed)) };
    const replay = (): Response | undefined => {
      const found = idempotency === undefined ? undefined : store.findRunByIdempotencyKey(session.id, idempotency.idempotencyKey);
      if (idempotency === undefined || found === undefined) return undefined;
      if (!sameRunRequest(found, idempotency.requestDigest)) throw idempotencyKeyReused();
      return json({ run: toRunView(found.run) }, 202, { location: `/v1/runs/${found.run.id}`, 'idempotent-replayed': 'true' });
    };
    if (deps.isDraining()) {
      const replayed = replay();
      if (replayed === undefined) throw drainingError();
      return replayed;
    }
    const replayed = replay();
    if (replayed !== undefined) return replayed;
    const skill = body.skill === undefined ? undefined : await activationOf(session, body.skill);
    if (body.images !== undefined && body.images.length > 0) {
      let capabilities: Capabilities;
      try {
        capabilities = await deps.modelCapabilities(session.modelAlias, context.req.raw.signal);
      } catch (error) {
        if (isGatewayUnavailable(error)) throw serviceUnavailable('gateway_unavailable', 'the model gateway is unavailable');
        throw error;
      }
      if (!capabilities.imageInput) throw imageInputUnsupported(session.modelAlias);
    }
    const result = store.createRunAndEnqueue(session.id, {
      input: body.input,
      ...idempotency,
      timeoutMs: body.timeoutMs ?? deps.defaults.runTimeoutMs,
      limits: { ...deps.defaults.limits, ...body.limits },
      pins: {},
      history: body.history ?? 'inherit',
      ...(skill === undefined ? {} : { skill }),
      ...(body.images === undefined ? {} : { images: body.images }),
    });
    if (result.kind === 'not_found') throw notFound(`session ${session.id} does not exist`);
    if (result.kind === 'key_reused') throw idempotencyKeyReused();
    return json({ run: toRunView(result.run) }, 202, {
      location: `/v1/runs/${result.run.id}`,
      ...(result.kind === 'existing' ? { 'idempotent-replayed': 'true' } : {}),
    });
  };

  const getRun: Handler = (context) => json({ run: toRunView(requireRun(context.req.param('id') ?? '')) });

  const cancelRun: Handler = (context) => {
    const id = context.req.param('id') ?? '';
    const before = store.getRun(id);
    const result = store.requestCancel(id);
    if (result.kind === 'not_found') throw notFound(`run ${id} does not exist`);
    if (deps.cancelUpstream !== undefined && before?.status === 'QUEUED' && result.changed && result.run.status === 'CANCELLED') {
      const cancelUpstream = deps.cancelUpstream;
      void (async () => cancelUpstream(id))().catch(deps.onError);
    }
    const settled = isTerminalStatus(result.run.status) && !result.changed;
    return json({ run: toRunView(result.run) }, settled ? 200 : 202);
  };

  const runTrace: Handler = async (context) => {
    const run = requireRun(context.req.param('id') ?? '');
    const trace = await deps.runTrace(run.id);
    if (trace === undefined) throw notFound(`run ${run.id} has no recorded trace`);
    return json(trace);
  };

  const cost: Handler = async (context) => {
    const runId = context.req.query('run');
    const sessionId = context.req.query('session');
    const requestedCwd = context.req.query('cwd');
    const given = [runId, sessionId, requestedCwd].filter((value) => value !== undefined);
    if (given.length > 1) throw invalidRequest('pass at most one of run, session and cwd', 'run');
    const runsOfSession = (id: string) => store.listRuns(id).map((run) => ({ runId: run.id, sessionId: run.sessionId }));
    let runs: { runId: string; sessionId: string }[];
    if (runId !== undefined) {
      const run = requireRun(runId);
      runs = [{ runId: run.id, sessionId: run.sessionId }];
    } else if (sessionId !== undefined) {
      runs = runsOfSession(requireSession(sessionId).id);
    } else if (requestedCwd !== undefined) {
      requireAbsolute(requestedCwd, 'cwd');
      let cwd: string;
      try {
        cwd = canonicalPath(requestedCwd);
      } catch (error) {
        if (isTransientErrno(error)) throw error;
        throw invalidRequest(`cwd ${requestedCwd} cannot be resolved: ${(error as Error).message}`, 'cwd');
      }
      runs = store.listSessions({ cwd }).flatMap((session) => runsOfSession(session.id));
    } else {
      runs = store.listSessions().flatMap((session) => runsOfSession(session.id));
    }
    const format = context.req.query('format') ?? 'json';
    if (format !== 'json' && format !== 'text') throw invalidRequest('format must be json or text', 'format');
    const { report, text } = await deps.runCost(runs, context.req.raw.signal);
    return format === 'json' ? json(report) : new Response(`${text}\n`, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  };

  const listRunApprovals: Handler = (context) => {
    const run = requireRun(context.req.param('id') ?? '');
    return json({ approvals: store.pendingApprovalViews(run.id) });
  };

  const getApproval: Handler = (context) => {
    const id = context.req.param('id') ?? '';
    const approval = store.approvalView(id);
    if (approval === undefined) throw notFound(`approval ${id} does not exist`);
    return json({ approval });
  };

  const resolveApproval: Handler = async (context) => {
    const id = context.req.param('id') ?? '';
    const body = validateBody<ResolveApprovalBody>('ResolveApprovalRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const result = store.resolveApproval(id, body.optionId);
    switch (result.kind) {
      case 'not_found':
        throw notFound(`approval ${id} does not exist`);
      case 'approval_not_pending':
        throw conflict('approval_not_pending', `approval ${id} is ${result.status}, not pending`);
      case 'request_missing':
        throw conflict('approval_not_pending', `approval ${id} has no recorded permission request`);
      case 'run_cancelled':
        throw conflict('run_cancelled', `the run of approval ${id} was cancelled`);
      case 'option_not_offered':
        throw invalidRequest(`option ${body.optionId} was not offered for approval ${id}`, 'optionId');
      case 'ok': {
        const approval = store.approvalView(result.approval.id);
        if (approval === undefined) throw new Error(`approval ${result.approval.id} vanished after it was resolved`);
        return json({ approval, run: toRunView(result.run) });
      }
    }
  };

  const streamOf = (context: Context, source: EventSource, cursor: number, watch: (wake: () => void) => () => void): Response =>
    context.req.method === 'HEAD'
      ? new Response(null, { status: 200, headers: STREAM_HEADERS })
      : eventStreamResponse({
          source,
          cursor,
          watch,
          timers: deps.timers,
          keepAliveMs: deps.keepAliveMs,
          signals: [deps.closeSignal, context.req.raw.signal],
          onError: deps.onError,
        });

  const runEvents: Handler = (context) => {
    const run = requireRun(context.req.param('id') ?? '');
    const cursor = parseCursor(context.req.raw, run.lastSeq);
    const source: EventSource = {
      read: (after, limit) => {
        const current = requireRun(run.id);
        return { events: store.readRunEvents(run.id, after, limit), endsAt: isTerminalStatus(current.status) ? current.lastSeq : undefined };
      },
      cursorOf: (event) => {
        if (!('seq' in event)) throw new Error(`run ${run.id} stream read a session event`);
        return event.seq;
      },
    };
    return streamOf(context, source, cursor, (wake) => notifier.watchRun(run.id, wake));
  };

  const sessionEvents: Handler = (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    const cursor = parseCursor(context.req.raw, store.sessionMaxEventId(session.id));
    const source: EventSource = {
      read: (after, limit) => ({ events: store.readSessionEvents(session.id, after, limit), endsAt: undefined }),
      cursorOf: (event) => event.id,
    };
    return streamOf(context, source, cursor, (wake) => notifier.watchSession(session.id, wake));
  };

  route('/v1/health', { GET: health });
  route('/v1/sessions', { GET: listSessions, POST: createSession });
  route('/v1/sessions/:id', { GET: getSession, PATCH: patchSession });
  route('/v1/sessions/:id/runs', { GET: listRuns, POST: createRun });
  route('/v1/sessions/:id/skills', { GET: listSkills });
  route('/v1/sessions/:id/events', { GET: sessionEvents });
  route('/v1/runs/:id', { GET: getRun });
  route('/v1/runs/:id/cancel', { POST: cancelRun });
  route('/v1/runs/:id/trace', { GET: runTrace });
  route('/v1/cost', { GET: cost });
  route('/v1/runs/:id/approvals', { GET: listRunApprovals });
  route('/v1/runs/:id/events', { GET: runEvents });
  route('/v1/approvals/:id', { GET: getApproval, POST: resolveApproval });
  registerTrustRoutes(route, { store, maxBodyBytes: deps.maxBodyBytes });
  registerMemoryRoutes(route, { store });
  registerInputRoutes(route, { store, mcp: deps.mcp, maxBodyBytes: deps.maxBodyBytes, closeSignal: deps.closeSignal });

  app.notFound(() => errorResponse(notFound('no such route')));
  app.onError((error) => {
    if (error instanceof ApiError) return errorResponse(error);
    deps.onError(error);
    return internalErrorResponse();
  });

  return app;
};

