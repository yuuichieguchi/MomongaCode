import { REPORT_PAGE_ROWS } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { invalidRequest } from './errors.ts';
import type { Handler, RouteRegistrar } from './app.ts';

const limitOf = (raw: string | undefined): number => {
  if (raw === undefined) return REPORT_PAGE_ROWS;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > REPORT_PAGE_ROWS) {
    throw invalidRequest(`limit must be an integer from 1 to ${REPORT_PAGE_ROWS}`, 'limit');
  }
  return limit;
};

export const registerReportRoutes = (route: RouteRegistrar, deps: { store: Pick<RuntimeStore, 'runFacts'> }): void => {
  const facts: Handler = (context) => {
    const page = deps.store.runFacts.page(context.req.query('cursor') ?? '', limitOf(context.req.query('limit')));
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  route('/v1/report/facts', { GET: facts });
};
