import path from 'node:path';
import type { Context } from 'hono';
import { pendingProjectItems } from '@momonga/config';
import type { PendingChange, PendingProjectItem, ProjectAgentsLister } from '@momonga/config';
import { createAgentLoader } from '@momonga/agents';
import type { ProjectAgentApproved } from '@momonga/agents';
import { createNodeSkillFileSystem } from '@momonga/skills';
import type { TrustItemChange, TrustItemsView } from '@momonga/protocol';
import { diffOfContents } from '@momonga/tools';
import { hostPaths, settledOrAborted } from '@momonga/foundation';
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

export const undecidedFolderNotice = async (
  trust: Pick<RuntimeStore['trust'], 'decisionAsked'>,
  folder: string,
  signal: AbortSignal,
): Promise<{ trustNotice: string } | Record<string, never>> => {
  if ((await trust.decisionAsked(folder, signal)).decision !== null) return {};
  return {
    trustNotice: `the folder ${folder} is not decided, so its own settings and everything they could make the product run are not loaded; decide it with momonga trust ${folder}`,
  };
};

const shownContent = (value: unknown): string => (typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);

const contentOf = (item: PendingProjectItem): unknown => {
  if (item.kind === 'hook') return item.group;
  if (item.kind === 'mandate') return item.document;
  if (item.kind === 'agent') return item.text;
  return item.config;
};

const NOTHING_APPROVED: ProjectAgentApproved = () => false;

const shownChange = (change: PendingChange, now: unknown): TrustItemChange => (change.kind === 'changed' ? { kind: 'changed', diff: diffOfContents(shownContent(change.earlier), shownContent(now)) } : change);

export const registerTrustRoutes = (route: RouteRegistrar, deps: { store: Pick<RuntimeStore, 'trust'>; maxBodyBytes: number; home: string }): void => {
  const { store } = deps;
  const agentLoader = createAgentLoader({ home: deps.home, fileSystem: createNodeSkillFileSystem() });
  const projectAgents: ProjectAgentsLister = async (projectDir, signal) =>
    (await settledOrAborted(agentLoader.load({ projectRoot: projectDir, trusted: true, projectAgentApproved: NOTHING_APPROVED }), signal)).pendingApproval;

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

  const getItems: Handler = async (context) => {
    const input = requiredPathQuery(context);
    const signal = context.req.raw.signal;
    const result = await hostPaths(signal).canonicalDirectory(input);
    if (!result.ok) {
      if (result.code === 'missing') throw notFound(`path ${input} ${result.reason}`);
      throw invalidRequest(`path ${input} ${result.reason}`, 'path');
    }
    const trust = { isTrusted: async (folder: string, asked: AbortSignal): Promise<boolean> => (await store.trust.decisionAsked(folder, asked)).decision === 'trusted' };
    const pending = await pendingProjectItems({ home: deps.home, projectDir: result.path, trust, agents: projectAgents, signal });
    const view: TrustItemsView = { items: pending.items.map((item) => ({ ...item, change: shownChange(item.change, contentOf(item)) })), refused: pending.refused };
    return json(view, 200);
  };

  route('/v1/trust', { GET: getTrust, PUT: putTrust, DELETE: deleteTrust }, { person: ['PUT', 'DELETE'] });
  route('/v1/trust/items', { GET: getItems });
};
