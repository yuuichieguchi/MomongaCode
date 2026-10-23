import { Hono } from 'hono';
import type { Context } from 'hono';
import type { GatewayHealth, ModelList, MomongaModelList } from '@momonga/protocol';
import { ClientDisconnectedError, GatewayError, invalidRequest, notFound } from '../core/errors.ts';
import type { ResponsesService, SubmitHeaders } from '../core/responses-service.ts';
import type { Services } from '../core/services.ts';
import type { UnaryService } from '../core/unary.ts';
import { readJsonBody } from './body.ts';
import { collectTerminalResource } from './response-body.ts';
import { sseResponse } from './sse.ts';
import type { RequestTracker } from './tracker.ts';

export type AppDependencies = {
  services: Services;
  responses: ResponsesService;
  unary: UnaryService;
  tracker: RequestTracker;
  startedAtSeconds: number;
  startedAt: string;
  version: string;
  onError: ((error: unknown) => void) | undefined;
};

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
});

export const createApp = (dependencies: AppDependencies): Hono => {
  const { services, responses, unary, tracker } = dependencies;
  const requestSignalOf = (context: Context): AbortSignal => AbortSignal.any([context.req.raw.signal, services.closeSignal]);
  const app = new Hono();

  app.notFound(() => errorResponse(notFound('route_not_found', 'no such route')));

  app.onError((error) => {
    if (error instanceof GatewayError) return errorResponse(error);
    if (error instanceof ClientDisconnectedError) return new Response(null, { status: 499 });
    dependencies.onError?.(error);
    return errorResponse(
      new GatewayError({ status: 500, type: 'server_error', code: 'internal_error', message: error.message }),
    );
  });

  app.post('/v1/responses', async (context) => {
    const raw = await readJsonBody(context.req.raw, services.config.limits.maxBodyBytes);
    const release = tracker.begin();
    let streaming = false;
    try {
      const submission = responses.submit(raw, submitHeadersOf(context), context.req.raw.signal);
      const first = await submission.events.next();
      if (first.done === true) throw new ClientDisconnectedError();
      if (submission.stream) {
        streaming = true;
        return sseResponse(first.value, submission.events, {
          timers: services.timers,
          keepAliveMs: services.config.sseKeepAliveMs,
          signal: AbortSignal.any([context.req.raw.signal, services.forceCloseSignal, submission.events.evicted]),
          onEnd: release,
        });
      }
      try {
        return context.json(await collectTerminalResource(first.value, submission.events));
      } finally {
        await submission.events.return?.();
      }
    } finally {
      if (!streaming) release();
    }
  });

  app.post('/v1/responses/compact', async (context) => {
    const raw = await readJsonBody(context.req.raw, services.config.limits.maxBodyBytes);
    const release = tracker.begin();
    try {
      return context.json(
        await unary.compact(raw, context.req.raw.signal, context.req.header('momonga-deadline-ms'), context.req.header('idempotency-key')),
      );
    } finally {
      release();
    }
  });

  app.post('/v1/momonga/count_tokens', async (context) => {
    const raw = await readJsonBody(context.req.raw, services.config.limits.maxBodyBytes);
    const release = tracker.begin();
    try {
      return context.json(await unary.countTokens(raw, requestSignalOf(context), context.req.header('momonga-deadline-ms')));
    } finally {
      release();
    }
  });

  app.get('/v1/models', (context) => {
    const list: ModelList = {
      object: 'list',
      data: services.router
        .aliases()
        .map((id) => ({ id, object: 'model', created: dependencies.startedAtSeconds, owned_by: 'momonga' })),
    };
    return context.json(list);
  });

  app.get('/v1/momonga/models', async (context) => {
    const data = await Promise.all(
      services.router.aliases().map(async (id) => {
        const targets = services.router.targetsOf(id);
        return {
          id,
          object: 'model' as const,
          targets: targets.map((target) => target.name),
          capabilities: await services.router.aliasCapabilitiesOf(id),
        };
      }),
    );
    const list: MomongaModelList = { object: 'list', data };
    return context.json(list);
  });

  app.get('/v1/momonga/health', async (context) => {
    const report: GatewayHealth = {
      ...(await services.router.health()),
      version: dependencies.version,
      apiVersion: 1,
      pid: process.pid,
      startedAt: dependencies.startedAt,
      state: services.closeSignal.aborted ? 'draining' : 'running',
    };
    return context.json(report);
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

  return app;
};
