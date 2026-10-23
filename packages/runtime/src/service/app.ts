import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { stripCredentialEnv } from '@momonga/config';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { RUN_STATUSES } from '@momonga/protocol';
import type { PermissionMode, RunStatus } from '@momonga/protocol';
import type { Run, RuntimeStore } from '@momonga/store';
import {
  ApiError,
  conflict,
  errorResponse,
  idempotencyKeyReused,
  internalErrorResponse,
  invalidRequest,
  methodNotAllowed,
  modeNotAllowed,
  notFound,
} from './errors.ts';
import { STREAM_HEADERS, eventStreamResponse } from './event-stream.ts';
import type { EventSource } from './event-stream.ts';
import type { RunNotifier } from './notifier.ts';
import { JSON_MEDIA_TYPES, PATCH_MEDIA_TYPES, parseCursor, parseIdempotencyKey, readJson, validateBody } from './request.ts';
import type { CreateRunBody, CreateSessionBody, PatchSessionBody, ResolveApprovalBody } from './request.ts';
import type { ServiceTimers } from './timers.ts';
import { isTerminalStatus, toRunView, toSessionView } from './views.ts';

export type RunLimitDefaults = { maxSteps: number; maxTotalTokens: number; approvalTtlMs: number; loopThreshold: number };

export type RunServiceDefaults = { modelAlias: string; runTimeoutMs: number; limits: RunLimitDefaults };

export type SessionSettings = { defaultMode?: PermissionMode; defaultModeOrigin?: 'user' | 'project' | 'local' };

export type RunAppDeps = {
  store: RuntimeStore;
  clock: Clock;
  version: string;
  credentialEnvNames: () => readonly string[];
  modelAliases: () => Promise<readonly string[]>;
  settingsFor: (cwd: string) => Promise<SessionSettings>;
  defaults: RunServiceDefaults;
  notifier: RunNotifier;
  timers: ServiceTimers;
  keepAliveMs: number;
  maxBodyBytes: number;
  closeSignal: AbortSignal;
  onError: (error: unknown) => void;
};

type Handler = (context: Context) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const MISSING_PATH_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
const UNREADABLE_PATH_CODES: ReadonlySet<string> = new Set(['EACCES', 'ELOOP', 'ENAMETOOLONG']);

const pathFailure = (error: unknown, target: string): ApiError | undefined => {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  if (UNREADABLE_PATH_CODES.has(code)) return invalidRequest(`cwd ${target} cannot be read: ${code}`, 'cwd');
  return undefined;
};

const realpathOrUndefined = async (target: string): Promise<string | undefined> => {
  try {
    return await fs.promises.realpath(target);
  } catch (error) {
    if (MISSING_PATH_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw pathFailure(error, target) ?? error;
  }
};

const isDirectory = async (target: string): Promise<boolean> => {
  try {
    return (await fs.promises.stat(target)).isDirectory();
  } catch (error) {
    throw pathFailure(error, target) ?? error;
  }
};

const requireAbsolute = (value: string, label: string): void => {
  if (!path.isAbsolute(value)) throw invalidRequest(`${label} must be an absolute path`, label);
};

const checkModeAllowed = (mode: PermissionMode, bypassAllowed: boolean): void => {
  if (mode === 'auto') throw conflict('mode_unavailable', 'the auto permission mode is not available yet');
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

  const route = (routePath: string, handlers: Readonly<Record<string, Handler>>): void => {
    app.all(routePath, (context) => {
      const method = context.req.method;
      const handler = method === 'HEAD' ? handlers['GET'] : handlers[method];
      if (handler === undefined) throw methodNotAllowed(handlers['GET'] === undefined ? Object.keys(handlers) : [...Object.keys(handlers), 'HEAD']);
      return handler(context);
    });
  };

  const health: Handler = () => json({ status: 'ok', version: deps.version, apiVersion: 1 });

  const createSession: Handler = async (context) => {
    const body = validateBody<CreateSessionBody>('CreateSessionRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    requireAbsolute(body.cwd, 'cwd');
    const cwd = await realpathOrUndefined(body.cwd);
    if (cwd === undefined) throw invalidRequest(`cwd ${body.cwd} does not exist`, 'cwd');
    if (!(await isDirectory(cwd))) throw invalidRequest(`cwd ${body.cwd} is not a directory`, 'cwd');
    const modelAlias = body.modelAlias ?? deps.defaults.modelAlias;
    if (!(await deps.modelAliases()).includes(modelAlias)) throw invalidRequest(`unknown model alias ${modelAlias}`, 'modelAlias');
    const settings = await deps.settingsFor(cwd);
    const permissionMode = body.permissionMode ?? settings.defaultMode ?? 'default';
    const bypassAllowed =
      body.bypassAllowed === true || (settings.defaultMode === 'bypassPermissions' && settings.defaultModeOrigin === 'user');
    checkModeAllowed(permissionMode, bypassAllowed);
    const stripped = stripCredentialEnv(body.env, deps.credentialEnvNames());
    const session = store.createSession({ cwd, env: stripped.env, permissionMode, modelAlias, bypassAllowed });
    return json({ session: toSessionView(store, session), strippedEnvKeys: stripped.removed }, 201, { location: `/v1/sessions/${session.id}` });
  };

  const listSessions: Handler = async (context) => {
    const requested = context.req.query('cwd');
    if (requested === undefined) return json({ sessions: store.listSessions().map((session) => toSessionView(store, session)) });
    requireAbsolute(requested, 'cwd');
    const cwd = await realpathOrUndefined(requested);
    if (cwd === undefined) return json({ sessions: [] });
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

  const createRun: Handler = async (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    const idempotencyKey = parseIdempotencyKey(context.req.header('idempotency-key') ?? null);
    const parsed = await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes);
    const body = validateBody<CreateRunBody>('CreateRunRequest', parsed);
    const result = store.createRunAndEnqueue(session.id, {
      input: body.input,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey, requestDigest: sha256Hex(canonicalJson(parsed)) }),
      timeoutMs: body.timeoutMs ?? deps.defaults.runTimeoutMs,
      limits: { ...deps.defaults.limits, ...body.limits },
      pins: {},
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
    const result = store.requestCancel(id);
    if (result.kind === 'not_found') throw notFound(`run ${id} does not exist`);
    const settled = isTerminalStatus(result.run.status) && !result.changed;
    return json({ run: toRunView(result.run) }, settled ? 200 : 202);
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
  route('/v1/sessions/:id/events', { GET: sessionEvents });
  route('/v1/runs/:id', { GET: getRun });
  route('/v1/runs/:id/cancel', { POST: cancelRun });
  route('/v1/runs/:id/approvals', { GET: listRunApprovals });
  route('/v1/runs/:id/events', { GET: runEvents });
  route('/v1/approvals/:id', { GET: getApproval, POST: resolveApproval });

  app.notFound(() => errorResponse(notFound('no such route')));
  app.onError((error) => {
    if (error instanceof ApiError) return errorResponse(error);
    deps.onError(error);
    return internalErrorResponse();
  });

  return app;
};

