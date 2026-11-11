import { Hono } from 'hono';
import type { Context } from 'hono';
import { MAX_TRACE_CONTENT_PAGE, QUOTE_ROUTE, ROLE_HEADER, RUN_ID_HEADER, STREAM_IDLE_HEADER } from '@momonga/protocol';
import { MAX_BILLED_CALLS_PAGE } from '@momonga/observability';
import type { BilledCallsCursorView, BilledCallsPageView, GatewayCostReportView, GatewayHealth, ModelList, MomongaModelList, TraceContentPage } from '@momonga/protocol';
import { ClientDisconnectedError, GatewayError, gatewayClosedError, generationRetiredError, invalidRequest, notFound } from '../core/errors.ts';
import type { ResponsesService, SubmitHeaders } from '../core/responses-service.ts';
import type { PlanApi } from '../plan/api.ts';
import { PLAN_API_PREFIX, PLAN_ROUTES } from '@momonga/protocol';
import { quoteOf } from '../core/quote.ts';
import { roleOfHeader } from '../core/role.ts';
import { withPinnedServices } from '../core/services.ts';
import type { GatewayServices } from '../core/services.ts';
import type { UnaryService } from '../core/unary.ts';
import { readJsonBody } from './body.ts';
import { listModel } from './capability-listing.ts';
import type { ErrorExit } from './error-exit.ts';
import { collectTerminalResource } from './response-body.ts';
import { compactSseResponse, sseResponse } from './sse.ts';
import type { RequestTracker } from './tracker.ts';

export type AppDependencies = {
  services: GatewayServices;
  responses: ResponsesService;
  unary: UnaryService;
  tracker: RequestTracker;
  isRetiring: () => boolean;
  activeRequests: () => number;
  startedAtSeconds: number;
  startedAt: string;
  version: string;
  costReport: ((runs: readonly { runId: string; sessionId: string }[], includeRunless: boolean, signal: AbortSignal) => Promise<{ report: GatewayCostReportView; text: string }>) | undefined;
  billedCalls: ((runIds: readonly string[], cursor: BilledCallsCursorView, limit: number, includeRunless: boolean, signal: AbortSignal) => Promise<BilledCallsPageView>) | undefined;
  traceContent: ((runId: string, after: number, limit: number, signal: AbortSignal) => Promise<TraceContentPage>) | undefined;
  errors: ErrorExit;
  plan: PlanApi | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const errorResponse = (error: GatewayError): Response =>
  new Response(JSON.stringify({ error: error.body }), {
    status: error.status,
    headers: { 'content-type': 'application/json', ...error.headers },
  });

const submitHeadersOf = (context: Context): SubmitHeaders => ({
  idempotencyKey: context.req.header('idempotency-key'),
  deadlineMs: context.req.header('momonga-deadline-ms'),
  traceparent: context.req.header('traceparent'),
  tracestate: context.req.header('tracestate'),
  role: roleOfHeader(context.req.header(ROLE_HEADER)),
});

const KEEP_ALIVES_PER_IDLE_BOUND = 3;

const streamIdleBoundOf = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,15}$/.test(value)) {
    throw invalidRequest('invalid_stream_idle', `the ${STREAM_IDLE_HEADER} header must be a positive integer number of milliseconds`);
  }
  return Number(value);
};

export const createApp = (dependencies: AppDependencies): Hono => {
  const { services, responses, unary, tracker } = dependencies;
  const requestSignalOf = (context: Context): AbortSignal => AbortSignal.any([context.req.raw.signal, services.closeSignal]);
  const keepAliveMsFor = (idleBoundMs: number): number =>
    Math.min(services.config.sseKeepAliveMs, Math.max(1, Math.floor(idleBoundMs / KEEP_ALIVES_PER_IDLE_BOUND)));
  const app = new Hono();
  const refuseWhileRetiring = (): void => {
    if (dependencies.isRetiring()) throw generationRetiredError();
  };

  app.use(async (context, next) => {
    await next();
    if (dependencies.isRetiring()) context.header('connection', 'close');
  });

  app.notFound(() => errorResponse(notFound('route_not_found', 'no such route')));

  app.onError((error) => {
    if (error instanceof ClientDisconnectedError) return new Response(null, { status: 499 });
    return errorResponse(dependencies.errors.answer(error));
  });

  app.post('/v1/responses', async (context) => {
    refuseWhileRetiring();
    const raw = await readJsonBody(context.req.raw, services.config.limits.maxBodyBytes);
    const release = tracker.begin();
    let streaming = false;
    try {
      const idleBoundMs = streamIdleBoundOf(context.req.header(STREAM_IDLE_HEADER));
      const submission = await responses.submit(raw, submitHeadersOf(context), context.req.raw.signal);
      const shownEvents = dependencies.errors.shownFrom(submission.events);
      const streamOptions = {
        timers: services.timers,
        readerStallMs: services.config.limits.readerStallMs,
        signal: AbortSignal.any([context.req.raw.signal, services.forceCloseSignal, submission.events.evicted]),
        onEnd: release,
        onError: dependencies.errors.report,
      };
      if (submission.stream && idleBoundMs !== undefined) {
        streaming = true;
        return sseResponse(undefined, shownEvents, { ...streamOptions, keepAliveMs: keepAliveMsFor(idleBoundMs) });
      }
      const first = await shownEvents.next();
      if (first.done === true) throw new ClientDisconnectedError();
      if (submission.stream) {
        streaming = true;
        return sseResponse(first.value, shownEvents, { ...streamOptions, keepAliveMs: services.config.sseKeepAliveMs });
      }
      try {
        return context.json(await collectTerminalResource(first.value, shownEvents));
      } finally {
        await submission.events.return?.();
      }
    } finally {
      if (!streaming) release();
    }
  });

  app.post('/v1/responses/compact', async (context) => {
    refuseWhileRetiring();
    const raw = await readJsonBody(context.req.raw, services.config.limits.maxBodyBytes);
    const release = tracker.begin();
    let streaming = false;
    try {
      const idleBoundMs = streamIdleBoundOf(context.req.header(STREAM_IDLE_HEADER));
      const work = unary.compact(raw, context.req.raw.signal, context.req.header('momonga-deadline-ms'), context.req.header('idempotency-key'), {
        runId: context.req.header(RUN_ID_HEADER),
        traceparent: context.req.header('traceparent'),
        tracestate: context.req.header('tracestate'),
      });
      if (idleBoundMs === undefined) return context.json(await work);
      streaming = true;
      const shownWork = work.catch((error: unknown) => {
        throw dependencies.errors.shown(error);
      });
      return compactSseResponse(shownWork, {
        timers: services.timers,
        keepAliveMs: keepAliveMsFor(idleBoundMs),
        signal: AbortSignal.any([context.req.raw.signal, services.forceCloseSignal]),
        onEnd: release,
        onError: dependencies.errors.report,
      });
    } finally {
      if (!streaming) release();
    }
  });

  app.post('/v1/momonga/count_tokens', async (context) => {
    refuseWhileRetiring();
    const raw = await readJsonBody(context.req.raw, services.config.limits.maxBodyBytes);
    const release = tracker.begin();
    try {
      return context.json(await unary.countTokens(raw, requestSignalOf(context), context.req.header('momonga-deadline-ms')));
    } finally {
      release();
    }
  });

  app.get('/v1/models', (context) =>
    withPinnedServices(services, requestSignalOf(context), async ({ router }) => {
      const list: ModelList = {
        object: 'list',
        data: router.views().map((view) => ({ id: view.canon, object: 'model', created: dependencies.startedAtSeconds, owned_by: view.provider })),
      };
      return context.json(list);
    }),
  );

  app.get('/v1/momonga/models', (context) => {
    const signal = requestSignalOf(context);
    return withPinnedServices(services, signal, async ({ router }) => {
      const data = await Promise.all(router.models().map((model) => listModel(router, model, signal)));
      const list: MomongaModelList = { object: 'list', data, start: router.start(), roles: router.roles() };
      return context.json(list);
    });
  });

  app.get('/v1/momonga/health', (context) =>
    withPinnedServices(services, requestSignalOf(context), async ({ router }) => {
      const report: GatewayHealth = {
        ...(await router.health()),
        version: dependencies.version,
        apiVersion: 1,
        pid: process.pid,
        startedAt: dependencies.startedAt,
        state: services.closeSignal.aborted ? 'draining' : dependencies.isRetiring() ? 'retiring' : 'running',
        activeRequests: dependencies.activeRequests(),
      };
      return context.json(report);
    }),
  );

  app.post(QUOTE_ROUTE, async (context) => {
    const raw = await readJsonBody(context.req.raw, services.config.limits.maxBodyBytes);
    const model = isRecord(raw) ? raw['model'] : undefined;
    if (typeof model !== 'string' || model === '') throw invalidRequest('invalid_body', 'model is required and must be a non-empty string', 'model');
    return withPinnedServices(services, requestSignalOf(context), async ({ router, priceTable }) => context.json(quoteOf(router, model, priceTable, services.clock.now())));
  });

  app.post('/v1/momonga/responses/cancel', (context) =>
    context.json({
      cancelled: [responses.cancel(context.req.header('idempotency-key')), unary.cancel(context.req.header('idempotency-key'))].some(Boolean),
    }),
  );

  app.get('/v1/momonga/usage', (context) => {
    const runId = context.req.query('run_id');
    if (runId === undefined || runId === '') {
      throw invalidRequest('invalid_query', 'the run_id query parameter is required', 'run_id');
    }
    return context.json(services.store.usageReport(runId));
  });

  app.post('/v1/momonga/cost', async (context) => {
    if (dependencies.costReport === undefined) throw notFound('cost_unavailable', 'this gateway keeps no trace store to price runs from');
    const raw = await readJsonBody(context.req.raw, services.config.limits.maxBodyBytes);
    const runs = (raw as { runs?: unknown }).runs;
    if (
      !Array.isArray(runs) ||
      !runs.every((run): run is { runId: string; sessionId: string } => typeof run?.runId === 'string' && typeof run?.sessionId === 'string')
    ) {
      throw invalidRequest('invalid_body', 'runs must be a list of { runId, sessionId }', 'runs');
    }
    const includeRunless = (raw as { includeRunless?: unknown }).includeRunless;
    if (typeof includeRunless !== 'boolean') throw invalidRequest('invalid_body', 'includeRunless must be a boolean', 'includeRunless');
    return context.json(await dependencies.costReport(runs, includeRunless, requestSignalOf(context)));
  });

  app.post('/v1/momonga/cost/calls', async (context) => {
    if (dependencies.billedCalls === undefined) throw notFound('cost_unavailable', 'this gateway keeps no trace store to price runs from');
    const raw = await readJsonBody(context.req.raw, services.config.limits.maxBodyBytes);
    const { runIds, cursor, limit, includeRunless } = isRecord(raw) ? raw : { runIds: undefined, cursor: undefined, limit: undefined, includeRunless: undefined };
    if (typeof includeRunless !== 'boolean') throw invalidRequest('invalid_body', 'includeRunless must be a boolean', 'includeRunless');
    if (!Array.isArray(runIds) || !runIds.every((runId): runId is string => typeof runId === 'string') || new Set(runIds).size !== runIds.length) {
      throw invalidRequest('invalid_body', 'runIds must be a list of distinct run ids', 'runIds');
    }
    if (!isRecord(cursor) || !isCount(cursor['run']) || !isCount(cursor['after']) || cursor['run'] > runIds.length) {
      throw invalidRequest('invalid_body', 'cursor must be { run, after } with run no larger than the number of runIds', 'cursor');
    }
    if (!isCount(limit) || limit < 1 || limit > MAX_BILLED_CALLS_PAGE) {
      throw invalidRequest('invalid_body', `limit must be an integer from 1 to ${MAX_BILLED_CALLS_PAGE}`, 'limit');
    }
    return context.json(await dependencies.billedCalls(runIds, { run: cursor['run'], after: cursor['after'] }, limit, includeRunless, requestSignalOf(context)));
  });

  app.get('/v1/momonga/content', async (context) => {
    if (dependencies.traceContent === undefined) throw notFound('content_unavailable', 'this gateway keeps no trace store to read content from');
    const runId = context.req.query('run_id');
    if (runId === undefined || runId === '') throw invalidRequest('invalid_query', 'the run_id query parameter is required', 'run_id');
    const after = Number(context.req.query('after') ?? '0');
    if (!isCount(after)) throw invalidRequest('invalid_query', 'after must be a non-negative integer', 'after');
    const limit = Number(context.req.query('limit') ?? String(MAX_TRACE_CONTENT_PAGE));
    if (!isCount(limit) || limit < 1 || limit > MAX_TRACE_CONTENT_PAGE) throw invalidRequest('invalid_query', `limit must be an integer from 1 to ${MAX_TRACE_CONTENT_PAGE}`, 'limit');
    return context.json(await dependencies.traceContent(runId, after, limit, requestSignalOf(context)));
  });

  const planRoute = (route: string): string => `${PLAN_API_PREFIX}${route}`;
  const planApi = (): PlanApi => {
    if (dependencies.plan === undefined) throw notFound('plan_unavailable', 'this gateway serves no plan sign-in');
    return dependencies.plan;
  };
  const planBody = (context: Context): Promise<unknown> => readJsonBody(context.req.raw, services.config.limits.maxBodyBytes);
  const accountParam = (context: Context): string => {
    const account = context.req.param('account');
    if (account === undefined || account === '') throw invalidRequest('invalid_path', 'the account label is missing from the path', 'account');
    return account;
  };

  const closedOr = (error: unknown): never => {
    throw services.closeSignal.aborted ? gatewayClosedError() : error;
  };

  app.get(planRoute(PLAN_ROUTES.accounts), (context) =>
    withPinnedServices(services, requestSignalOf(context), async ({ planTargets }) => context.json(await planApi().accounts(planTargets, requestSignalOf(context)))),
  );
  app.post(planRoute(PLAN_ROUTES.accountsActive), async (context) => context.json(await planApi().setActive(await planBody(context), requestSignalOf(context))));
  app.post(planRoute(PLAN_ROUTES.signInBegin), async (context) => context.json(await planApi().begin(await planBody(context), requestSignalOf(context))));
  app.post(planRoute(PLAN_ROUTES.signInComplete), async (context) => {
    const body = await planBody(context);
    const signal = requestSignalOf(context);
    return withPinnedServices(services, signal, async ({ planTargets }) => context.json(await planApi().complete(body, planTargets, signal))).catch(closedOr);
  });
  app.post(planRoute(PLAN_ROUTES.signInCancel), async (context) => context.json(planApi().cancel(await planBody(context))));
  app.post(planRoute(PLAN_ROUTES.signOut), async (context) => {
    const body = await planBody(context);
    return context.json(await planApi().signOut(body, requestSignalOf(context)).catch(closedOr));
  });
  app.post(planRoute(PLAN_ROUTES.accountResume), async (context) => {
    const body = await planBody(context);
    return withPinnedServices(services, requestSignalOf(context), async ({ planTargets }) => context.json(await planApi().resume(accountParam(context), body, planTargets, requestSignalOf(context))));
  });
  app.get(planRoute(PLAN_ROUTES.accountModels), async (context) =>
    context.json(
      await planApi()
        .models(accountParam(context), { profile: context.req.query('profile'), refresh: context.req.query('refresh') }, requestSignalOf(context))
        .catch(closedOr),
    ),
  );
  app.post(planRoute(PLAN_ROUTES.accountTargets), async (context) => context.json(await planApi().addTarget(accountParam(context), await planBody(context), requestSignalOf(context))));
  app.post(planRoute(PLAN_ROUTES.hostReset), async (context) => context.json(await planApi().resetHost()));

  return app;
};
