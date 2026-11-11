import path from 'node:path';
import type { Context } from 'hono';
import type { Clock } from '@momonga/foundation';
import { checkGoverningFact, normalizeTarget, overlappingEnforced, resolveGoverning, ruleSizeReport } from '@momonga/memory';
import { displayOf, enforcedBehaviorOf, tokensForText } from '@momonga/protocol';
import type { AddRuleRequest, Capabilities, GoverningFactView, ModelView, ModelViews, PolicyGovernanceResponse, PolicyVerifyRequest, RuleAddResponse } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { GatewayRequestError, ModelUnlistedError } from '../gateway-client.ts';
import { ruleParses } from '../governance/rules.ts';
import type { PolicyVerification } from '../process/folder-verification.ts';
import { invalidRequest, notFound } from './errors.ts';
import type { Handler, ModelListing, RouteRegistrar } from './app.ts';
import { canonicalProject } from './project-query.ts';
import { JSON_MEDIA_TYPES, readJson, validateBody } from './request.ts';

export type RuleRoutesDeps = {
  store: Pick<RuntimeStore, 'governing'>;
  policyVerification: PolicyVerification;
  clock: Clock;
  modelListing: (signal: AbortSignal) => Promise<ModelListing>;
  modelCapabilities: (model: string, signal: AbortSignal) => Promise<Capabilities>;
  maxBodyBytes: number;
  refuseWhileRetiring(): void;
};

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const requiredProject = (context: Context): Promise<string> => {
  const raw = new URL(context.req.url).searchParams.get('project');
  if (raw === null || raw === '') return Promise.reject(invalidRequest('the project query parameter is required', 'project'));
  return canonicalProject(raw, 'project', context.req.raw.signal);
};

const overlapWarning = (existing: GoverningFactView): string =>
  `${existing.id} enforces ${existing.enforcement?.behavior ?? ''} ${existing.enforcement?.rule ?? ''} for the same target; a rule never allows, so this text cannot carve an exception out of it`;

export const registerRuleRoutes = (route: RouteRegistrar, deps: RuleRoutesDeps): void => {
  const { governing } = deps.store;

  const requireFact = (context: Context): GoverningFactView => {
    const id = context.req.param('id') ?? '';
    const fact = governing.get(id);
    if (fact === undefined) throw notFound(`rule ${id} does not exist`);
    return fact;
  };

  type ModelWindow = { measured: true; target: string; contextWindow: number } | { measured: false; warning: string };

  const windowOf = async (view: ModelView, views: ModelViews, signal: AbortSignal): Promise<ModelWindow> => {
    try {
      return { measured: true, target: view.canon, contextWindow: (await deps.modelCapabilities(view.canon, signal)).contextWindow };
    } catch (error) {
      if (!(error instanceof ModelUnlistedError)) throw error;
      return { measured: false, warning: `the size of this rule was not measured against the model "${displayOf(view, views)}": ${error.message}` };
    }
  };

  const sizeOf = async (tokens: number, signal: AbortSignal): Promise<{ size: RuleAddResponse['size']; warnings: string[] }> => {
    const { views } = await deps.modelListing(signal);
    const windows = await Promise.all(views.map((view) => windowOf(view, views, signal)));
    return {
      size: ruleSizeReport(tokens, windows.flatMap((window) => (window.measured ? [{ target: window.target, contextWindow: window.contextWindow }] : []))),
      warnings: windows.flatMap((window) => (window.measured ? [] : [window.warning])),
    };
  };

  const sizeOrWarning = async (tokens: number, signal: AbortSignal): Promise<{ size: RuleAddResponse['size']; warnings: string[] }> => {
    try {
      return await sizeOf(tokens, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof GatewayRequestError)) throw error;
      return { size: [], warnings: [`the size of this rule could not be measured because the gateway did not answer: ${error.message}`] };
    }
  };

  const addRule: Handler = async (context) => {
    const body = validateBody<AddRuleRequest>('AddRuleRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    deps.refuseWhileRetiring();
    const scope: GoverningFactView['scope'] =
      body.scope.level === 'user' ? body.scope : { level: 'project', project: await canonicalProject(body.scope.project, 'scope.project', context.req.raw.signal), paths: body.scope.paths };
    const input = {
      kind: body.kind,
      target: normalizeTarget(body.target),
      text: body.text,
      scope,
      validUntil: body.validUntil ?? null,
      supersedes: body.supersedes ?? [],
      enforcement: body.enforcement ?? null,
      source: { kind: 'command' as const },
    };
    const sized = await sizeOrWarning(tokensForText(input.text), context.req.raw.signal);
    const candidate: GoverningFactView = { ...input, id: '', validFrom: 0, retiredAt: null, source: { kind: 'command', at: 0 } };
    let existing: readonly GoverningFactView[] = [];
    const added = governing.addAdmitted(input, (facts) => {
      existing = facts;
      return checkGoverningFact(candidate, { existing: facts, parses: ruleParses });
    });
    if (added.kind === 'refused') throw invalidRequest(added.message);
    const { fact } = added;
    const applicable = existing.filter((other) => other.scope.level === 'user' || (scope.level === 'project' && other.scope.level === 'project' && other.scope.project === scope.project));
    const warnings = [...overlappingEnforced(fact, applicable).map(overlapWarning), ...sized.warnings];
    return json({ fact, size: sized.size, warnings } satisfies RuleAddResponse, 201);
  };

  const listRules: Handler = async (context) => json({ facts: governing.list({ project: await requiredProject(context) }) }, 200);

  const retireRule: Handler = (context) => {
    const { id } = requireFact(context);
    const retired = governing.retire(id);
    if (retired === undefined) throw new Error(`rule ${id} vanished while it was retired`);
    return json({ fact: retired.fact }, 200);
  };

  const ruleHistory: Handler = (context) => json({ facts: governing.history(requireFact(context).id) }, 200);

  const policyGovernance: Handler = async (context) => {
    const project = await requiredProject(context);
    const { active } = resolveGoverning(governing.list({ project }), { now: deps.clock.now(), project, touchedPaths: [], ignorePaths: true });
    const response: PolicyGovernanceResponse = {
      rules: active.flatMap((fact) => (fact.enforcement === null ? [] : [{ id: fact.id, behavior: enforcedBehaviorOf(fact.enforcement.behavior), rule: fact.enforcement.rule }])),
      textOnly: active.filter((fact) => fact.enforcement === null),
    };
    return json(response, 200);
  };

  route('/v1/rules', { GET: listRules, POST: addRule }, { person: ['POST'] });
  route('/v1/rules/:id/retire', { POST: retireRule }, { person: ['POST'] });
  route('/v1/rules/:id/history', { GET: ruleHistory });
  const verifyPolicy: Handler = async (context) => {
    const body = validateBody<PolicyVerifyRequest>('PolicyVerifyRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const relative = body.secrets.find((secret) => !path.isAbsolute(secret));
    if (relative !== undefined) throw invalidRequest(`the secret location ${JSON.stringify(relative)} must be an absolute path`, 'secrets');
    const cwd = await canonicalProject(body.project, 'project', context.req.raw.signal);
    const answer = await deps.policyVerification(
      { cwd, secrets: body.secrets, ...(body.mode === undefined ? {} : { mode: body.mode }), ...(body.mandate === undefined ? {} : { mandate: body.mandate }) },
      context.req.raw.signal,
    );
    return json(answer, 200);
  };

  route('/v1/policy/governance', { GET: policyGovernance });
  route('/v1/policy/verify', { POST: verifyPolicy }, { person: ['POST'] });
};
