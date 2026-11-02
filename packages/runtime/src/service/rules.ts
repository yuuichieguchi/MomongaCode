import type { Context } from 'hono';
import type { Clock } from '@momonga/foundation';
import { checkGoverningFact, normalizeTarget, overlappingEnforced, resolveGoverning, ruleSizeReport } from '@momonga/memory';
import { tokensForText } from '@momonga/protocol';
import type { AddRuleRequest, Capabilities, GoverningFactView, PolicyGovernanceResponse, RuleAddResponse } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { ruleParses } from '../governance/rules.ts';
import { invalidRequest, notFound } from './errors.ts';
import type { Handler, RouteRegistrar } from './app.ts';
import { canonicalProject } from './project-query.ts';
import { JSON_MEDIA_TYPES, readJson, validateBody } from './request.ts';

export type RuleRoutesDeps = {
  store: Pick<RuntimeStore, 'governing'>;
  clock: Clock;
  modelAliases: () => Promise<readonly string[]>;
  modelCapabilities: (alias: string, signal: AbortSignal) => Promise<Capabilities>;
  maxBodyBytes: number;
  closeSignal: AbortSignal;
};

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const requiredProject = (context: Context): string => {
  const raw = new URL(context.req.url).searchParams.get('project');
  if (raw === null || raw === '') throw invalidRequest('the project query parameter is required', 'project');
  return canonicalProject(raw, 'project');
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

  const sizeOf = async (tokens: number) => {
    const aliases = await deps.modelAliases();
    const targets = await Promise.all(
      aliases.map(async (alias) => ({ target: alias, contextWindow: (await deps.modelCapabilities(alias, deps.closeSignal)).contextWindow })),
    );
    return ruleSizeReport(tokens, targets);
  };

  const addRule: Handler = async (context) => {
    const body = validateBody<AddRuleRequest>('AddRuleRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const scope: GoverningFactView['scope'] =
      body.scope.level === 'user' ? body.scope : { level: 'project', project: canonicalProject(body.scope.project, 'scope.project'), paths: body.scope.paths };
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
    const existing = governing.list();
    const checked = checkGoverningFact({ ...input, id: '', validFrom: 0, retiredAt: null, source: { kind: 'command', at: 0 } }, { existing, parses: ruleParses });
    if (!checked.ok) throw invalidRequest(checked.message);
    const { fact } = governing.add(input);
    const applicable = existing.filter((other) => other.scope.level === 'user' || (scope.level === 'project' && other.scope.project === scope.project));
    const warnings = overlappingEnforced(fact, applicable).map(overlapWarning);
    return json({ fact, size: await sizeOf(tokensForText(fact.text)), warnings } satisfies RuleAddResponse, 201);
  };

  const listRules: Handler = (context) => json({ facts: governing.list({ project: requiredProject(context) }) }, 200);

  const retireRule: Handler = (context) => {
    const { id } = requireFact(context);
    const retired = governing.retire(id);
    if (retired === undefined) throw new Error(`rule ${id} vanished while it was retired`);
    return json({ fact: retired.fact }, 200);
  };

  const ruleHistory: Handler = (context) => json({ facts: governing.history(requireFact(context).id) }, 200);

  const policyGovernance: Handler = (context) => {
    const project = requiredProject(context);
    const { active } = resolveGoverning(governing.list({ project }), { now: deps.clock.now(), project, touchedPaths: [], ignorePaths: true });
    const response: PolicyGovernanceResponse = {
      rules: active.flatMap((fact) => (fact.enforcement === null ? [] : [{ id: fact.id, behavior: fact.enforcement.behavior, rule: fact.enforcement.rule }])),
      textOnly: active.filter((fact) => fact.enforcement === null),
    };
    return json(response, 200);
  };

  route('/v1/rules', { GET: listRules, POST: addRule });
  route('/v1/rules/:id/retire', { POST: retireRule });
  route('/v1/rules/:id/history', { GET: ruleHistory });
  route('/v1/policy/governance', { GET: policyGovernance });
};
