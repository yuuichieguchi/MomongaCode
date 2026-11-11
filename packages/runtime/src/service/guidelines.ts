import type { Context } from 'hono';
import { MIN_SUMMARY_TOKENS, tokensForText } from '@momonga/protocol';
import type { AdoptGuidelineRequest, RecordContextChargeRequest } from '@momonga/protocol';
import { DuplicateChargeError, GuidelineConflictError, GuidelineTextError } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { conflict, invalidRequest, notFound } from './errors.ts';
import type { Handler, RouteRegistrar } from './app.ts';
import { canonicalProject } from './project-query.ts';
import { JSON_MEDIA_TYPES, readJson, validateBody } from './request.ts';

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export type GuidelineRoutesDeps = {
  store: Pick<RuntimeStore, 'guidelines' | 'contextCharges'>;
  maxBodyBytes: number;
};

export const registerGuidelineRoutes = (route: RouteRegistrar, deps: GuidelineRoutesDeps): void => {
  const { guidelines, contextCharges } = deps.store;

  const listGuidelines: Handler = () => json({ current: guidelines.current() ?? null, guidelines: guidelines.list() }, 200);

  const adoptGuideline: Handler = async (context) => {
    const body = validateBody<AdoptGuidelineRequest>('AdoptGuidelineRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    if (tokensForText(body.text) > MIN_SUMMARY_TOKENS) {
      throw invalidRequest(`a guideline is at most ${MIN_SUMMARY_TOKENS} estimated tokens, because the summariser refuses a longer one`, 'text');
    }
    try {
      return json({ guideline: guidelines.adopt(body) }, 201);
    } catch (error) {
      if (error instanceof GuidelineConflictError) throw conflict('guideline_conflict', error.message);
      if (error instanceof GuidelineTextError) throw invalidRequest(error.message, 'text');
      throw error;
    }
  };

  const rollbackGuideline = (context: Context): Response => {
    const raw = context.req.param('version') ?? '';
    const version = Number(raw);
    if (!Number.isInteger(version) || version < 1) throw invalidRequest(`version ${raw} must be an integer of at least 1`, 'version');
    if (guidelines.get(version) === undefined) throw notFound(`no guideline version ${version}`);
    return json({ guideline: guidelines.rollback(version) }, 201);
  };

  const recordCharge: Handler = async (context) => {
    const body = validateBody<RecordContextChargeRequest>('RecordContextChargeRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    try {
      return json({ charge: contextCharges.record({ ...body, runId: null, project: await canonicalProject(body.project, 'project', context.req.raw.signal) }) }, 201);
    } catch (error) {
      if (error instanceof DuplicateChargeError) throw conflict('duplicate_charge', error.message);
      throw error;
    }
  };

  route('/v1/guidelines', { GET: listGuidelines, POST: adoptGuideline }, { person: ['POST'] });
  route('/v1/guidelines/:version/rollback', { POST: rollbackGuideline }, { person: ['POST'] });
  route('/v1/context-charges', { POST: recordCharge });
};
