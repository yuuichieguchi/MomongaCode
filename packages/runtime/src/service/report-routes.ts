import { defineProductSchema, productErrorsText } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { MAX_TRACE_CONTENT_PAGE, REPORT_PAGE_ROWS, REPORT_SCHEMAS } from '@momonga/protocol';
import type { ReportCostPage, ReportCostRequest, RunCostView, StoreReviewRequest, StoreReviewResponse, TraceContentPage } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { invalidRequest, notFound } from './errors.ts';
import { JSON_MEDIA_TYPES, integerQueryOf, pageLimitOf, readJson } from './request.ts';
import type { Handler, RouteRegistrar } from './app.ts';

export type ReportRouteDeps = {
  store: Pick<RuntimeStore, 'runFacts' | 'permissionReviews' | 'getRun'>;
  now: () => number;
  maxBodyBytes: number;
  reportCost: (runIds: readonly string[], signal: AbortSignal) => Promise<RunCostView[]>;
  runTraceContent: (runId: string, after: number, limit: number) => Promise<TraceContentPage>;
};

const limitOf = (raw: string | undefined): number => pageLimitOf(raw, REPORT_PAGE_ROWS);

const bodyOf = <T>(validate: ProductValidator<T>, value: unknown): T => {
  const verdict = validate(value);
  if (!verdict.valid) throw invalidRequest(productErrorsText(verdict.errors, 'body'));
  return verdict.value;
};

const validateStoreReview: ProductValidator<StoreReviewRequest> = defineProductSchema('report/StoreReviewRequest', REPORT_SCHEMAS.StoreReviewRequest);
const validateReportCost: ProductValidator<ReportCostRequest> = defineProductSchema('report/ReportCostRequest', REPORT_SCHEMAS.ReportCostRequest);

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const registerReportRoutes = (route: RouteRegistrar, deps: ReportRouteDeps): void => {
  const facts: Handler = (context) => json(deps.store.runFacts.page(context.req.query('cursor') ?? '', limitOf(context.req.query('limit'))));

  const reviews: Handler = (context) => {
    const limit = limitOf(context.req.query('limit'));
    const cursor = context.req.query('cursor') ?? null;
    try {
      return json(deps.store.permissionReviews.page(cursor, limit));
    } catch (error) {
      if (error instanceof RangeError) throw invalidRequest(error.message, 'cursor');
      throw error;
    }
  };

  const storeReview: Handler = async (context) => {
    const request = bodyOf(validateStoreReview, await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const review = { ...request, reviewedAt: deps.now() };
    if (deps.store.permissionReviews.label(review) === 'unknown_call') {
      throw notFound(`run ${request.runId} has no recorded call ${request.callId}; a call is recorded when its run has ended and its facts are computed`);
    }
    const response: StoreReviewResponse = { review };
    return json(response, 201);
  };

  const cost: Handler = async (context) => {
    const { runIds } = bodyOf(validateReportCost, await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const page: ReportCostPage = { costs: await deps.reportCost(runIds, context.req.raw.signal) };
    return json(page);
  };

  const traceContent: Handler = async (context) => {
    const id = context.req.param('id') ?? '';
    if (deps.store.getRun(id) === undefined) throw notFound(`run ${id} does not exist`);
    const after = integerQueryOf(context.req.query('after'), 'after', { from: 0, to: Number.MAX_SAFE_INTEGER }) ?? 0;
    const limit = pageLimitOf(context.req.query('limit'), MAX_TRACE_CONTENT_PAGE);
    return json(await deps.runTraceContent(id, after, limit));
  };

  route('/v1/report/facts', { GET: facts });
  route('/v1/report/reviews', { GET: reviews, POST: storeReview });
  route('/v1/report/cost', { POST: cost });
  route('/v1/runs/:id/trace/content', { GET: traceContent });
};
