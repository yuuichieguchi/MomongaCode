import path from 'node:path';
import type { Context } from 'hono';
import { hostPaths } from '@momonga/foundation';
import type { RuntimeStore } from '@momonga/store';
import { invalidRequest, notFound } from './errors.ts';
import type { Handler, RouteRegistrar } from './app.ts';
import { JSON_MEDIA_TYPES, readJson, validateBody } from './request.ts';
import type { PutTrustBody } from './request.ts';

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const requiredPathQuery = (context: Context): string => {
  const target = new URL(context.req.url).searchParams.get('path');
  if (target === null || target === '') throw invalidRequest('the path query parameter is required', 'path');
  return target;
};

export const registerTrustRoutes = (route: RouteRegistrar, deps: { store: Pick<RuntimeStore, 'trust'>; maxBodyBytes: number }): void => {
  const { store } = deps;

  const viewOf = async (canonical: string, signal: AbortSignal): Promise<Response> => json({ trust: { path: canonical, ...(await store.trust.decisionAsked(canonical, signal)) } }, 200);

  const getTrust: Handler = async (context) => {
    const input = requiredPathQuery(context);
    const result = await hostPaths(context.req.raw.signal).canonicalDirectory(input);
    if (!result.ok) {
      if (result.code === 'missing') throw notFound(`path ${input} ${result.reason}`);
      throw invalidRequest(`path ${input} ${result.reason}`, 'path');
    }
    return viewOf(result.path, context.req.raw.signal);
  };

  const putTrust: Handler = async (context) => {
    const body = validateBody<PutTrustBody>('PutTrustRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const result = await hostPaths(context.req.raw.signal).canonicalDirectory(body.path);
    if (!result.ok) throw invalidRequest(`path ${body.path} ${result.reason}`, 'path');
    if (body.decision === 'trusted' && path.dirname(result.path) === result.path) {
      throw invalidRequest('the filesystem root cannot be trusted', 'decision');
    }
    await store.trust.setAsked(result.path, body.decision, context.req.raw.signal);
    return viewOf(result.path, context.req.raw.signal);
  };

  const deleteTrust: Handler = async (context) => {
    const input = requiredPathQuery(context);
    if (!path.isAbsolute(input)) throw invalidRequest(`path ${input} must be an absolute path`, 'path');
    await store.trust.clearAsked(input, context.req.raw.signal);
    return new Response(null, { status: 204 });
  };

  route('/v1/trust', { GET: getTrust, PUT: putTrust, DELETE: deleteTrust });
};
