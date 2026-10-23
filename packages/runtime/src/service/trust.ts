import path from 'node:path';
import type { Context } from 'hono';
import { canonicalDirectory } from '@momonga/foundation';
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

  const viewOf = (canonical: string): Response => json({ trust: { path: canonical, ...store.trust.decisionFor(canonical) } }, 200);

  const getTrust: Handler = (context) => {
    const input = requiredPathQuery(context);
    const result = canonicalDirectory(input);
    if (!result.ok) {
      if (result.code === 'missing') throw notFound(`path ${input} ${result.reason}`);
      throw invalidRequest(`path ${input} ${result.reason}`, 'path');
    }
    return viewOf(result.path);
  };

  const putTrust: Handler = async (context) => {
    const body = validateBody<PutTrustBody>('PutTrustRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const result = canonicalDirectory(body.path);
    if (!result.ok) throw invalidRequest(`path ${body.path} ${result.reason}`, 'path');
    if (body.decision === 'trusted' && path.dirname(result.path) === result.path) {
      throw invalidRequest('the filesystem root cannot be trusted', 'decision');
    }
    store.trust.set(result.path, body.decision);
    return viewOf(result.path);
  };

  const deleteTrust: Handler = (context) => {
    const input = requiredPathQuery(context);
    if (!path.isAbsolute(input)) throw invalidRequest(`path ${input} must be an absolute path`, 'path');
    store.trust.clear(input);
    return new Response(null, { status: 204 });
  };

  route('/v1/trust', { GET: getTrust, PUT: putTrust, DELETE: deleteTrust });
};
