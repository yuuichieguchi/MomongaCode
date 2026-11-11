import { RuleParseError, checkRuleText } from '@momonga/config';
import type { CeilingsSettings, LimitsSettings, MandateProfileSettings, ProjectMandate } from '@momonga/config';
import { composeBudget } from '@momonga/protocol';
import type { CompletionDeclaration, Mandate, MandateBudget, MandateScope } from '@momonga/protocol';
import { invalidRequest } from './errors.ts';

export type DelegationSettings = { limits?: LimitsSettings; ceilings?: CeilingsSettings; mandates?: Record<string, MandateProfileSettings> };

export type ChainBilling = { metered: boolean; priced: boolean };

export type DelegationPort = {
  settings(signal: AbortSignal): Promise<DelegationSettings>;
  projectMandate(cwd: string, signal: AbortSignal): Promise<ProjectMandate | undefined>;
  chainBilling(model: string, signal: AbortSignal): Promise<ChainBilling>;
};

export type RunTermsRequest = {
  mandate?: Mandate;
  limits?: Record<string, number | undefined>;
  timeoutMs?: number;
};

export type RunTerms = { mandate?: Mandate; limits: Record<string, number>; timeoutMs: number };

const SCOPE_EFFECTS = ['allow', 'ask', 'deny'] as const;

const union = (first: readonly string[] | undefined, second: readonly string[] | undefined): string[] => [...new Set([...(first ?? []), ...(second ?? [])])];

const scopeOfProfile = (profile: MandateProfileSettings): MandateScope => ({ allow: profile.allow ?? [], ask: profile.ask ?? [], deny: profile.deny ?? [] });

const budgetOfProfile = ({ steps, tokens, costUsd, timeMs, retries }: MandateProfileSettings): MandateBudget => ({
  ...(steps === undefined ? {} : { steps }),
  ...(tokens === undefined ? {} : { tokens }),
  ...(costUsd === undefined ? {} : { costUsd }),
  ...(timeMs === undefined ? {} : { timeMs }),
  ...(retries === undefined ? {} : { retries }),
});

const completionOfProfile = (profile: MandateProfileSettings): CompletionDeclaration | undefined =>
  profile.until === undefined && profile.require === undefined
    ? undefined
    : { ...(profile.until === undefined ? {} : { conditions: profile.until.map((command) => ({ command })) }), ...(profile.require === undefined ? {} : { requirements: [...profile.require] }) };

const mergedCompletion = (request: CompletionDeclaration | undefined, profile: CompletionDeclaration | undefined): CompletionDeclaration | undefined => {
  if (request === undefined || profile === undefined) return request ?? profile;
  return {
    conditions: [...(request.conditions ?? []), ...(profile.conditions ?? [])],
    requirements: union(request.requirements, profile.requirements),
    ...(request.inherit === undefined ? {} : { inherit: request.inherit }),
  };
};

const profileNamed = (name: string, settings: DelegationSettings): MandateProfileSettings => {
  const profile = settings.mandates?.[name];
  if (profile === undefined) {
    const known = Object.keys(settings.mandates ?? {});
    throw invalidRequest(`no mandate named ${JSON.stringify(name)} is declared in the user settings${known.length === 0 ? '' : ` (declared: ${known.join(', ')})`}`, 'mandate');
  }
  return profile;
};

const checkRules = (scope: MandateScope): void => {
  for (const effect of SCOPE_EFFECTS) {
    for (const rule of scope[effect] ?? []) {
      try {
        checkRuleText(rule);
      } catch (error) {
        if (error instanceof RuleParseError) throw invalidRequest(`the ${effect} rule ${JSON.stringify(rule)} of the mandate is not a permission rule: ${error.message}`, 'mandate');
        throw error;
      }
    }
  }
};

export const declaredMandateOf = (request: Mandate | undefined, settings: DelegationSettings): Mandate | undefined => {
  if (request === undefined) return undefined;
  const { profile: name, ...own } = request;
  if (name === undefined) return own;
  const profile = profileNamed(name, settings);
  const profileScope = scopeOfProfile(profile);
  const completion = mergedCompletion(own.completion, completionOfProfile(profile));
  const onQuiescent = own.hold?.onQuiescent ?? profile.onQuiescent;
  return {
    ...(completion === undefined ? {} : { completion }),
    scope: { allow: union(profileScope.allow, own.scope?.allow), ask: union(profileScope.ask, own.scope?.ask), deny: union(profileScope.deny, own.scope?.deny) },
    budget: { ...budgetOfProfile(profile), ...own.budget },
    ...(onQuiescent === undefined ? {} : { hold: { onQuiescent } }),
  };
};

const smaller = (first: number | undefined, second: number | undefined): number | undefined => (first === undefined ? second : second === undefined ? first : Math.min(first, second));

export type RunTermsInput = {
  request: RunTermsRequest;
  defaults: { runTimeoutMs: number; limits: Record<string, number> };
  settings: DelegationSettings;
  project?(): Promise<ProjectMandate | undefined>;
  billing(): Promise<ChainBilling>;
};

const BUDGET_DIMENSIONS = ['steps', 'tokens', 'costUsd', 'timeMs', 'retries'] as const;

export const narrowedByProject = (mandate: Mandate, project: ProjectMandate): Mandate => {
  const completion = mergedCompletion(mandate.completion, completionOfProfile(project));
  const budget: MandateBudget = {};
  for (const dimension of BUDGET_DIMENSIONS) {
    const value = smaller(mandate.budget?.[dimension], project[dimension]);
    if (value !== undefined) budget[dimension] = value;
  }
  return {
    ...mandate,
    ...(completion === undefined ? {} : { completion }),
    scope: { allow: mandate.scope?.allow ?? [], ask: union(mandate.scope?.ask, project.ask), deny: union(mandate.scope?.deny, project.deny) },
    budget,
  };
};

export const runTermsOf = async ({ request, defaults, settings, project, billing }: RunTermsInput): Promise<RunTerms> => {
  const declaredByUser = declaredMandateOf(request.mandate, settings);
  const declaredByProject = declaredByUser?.scope === undefined || project === undefined ? undefined : await project();
  const mandate = declaredByUser === undefined || declaredByProject === undefined ? declaredByUser : narrowedByProject(declaredByUser, declaredByProject);
  if (mandate?.scope !== undefined) checkRules(mandate.scope);
  const delegated = mandate?.scope !== undefined;
  const declared = mandate?.budget ?? {};
  const budget = delegated || mandate?.budget !== undefined ? composeBudget(declared, settings.ceilings ?? {}) : declared;
  const asked = Object.fromEntries(Object.entries(request.limits ?? {}).filter((entry): entry is [string, number] => entry[1] !== undefined));
  const standingCost = settings.limits?.maxCostUsd;
  const maxCostUsd = smaller(asked['maxCostUsd'] ?? standingCost, budget.costUsd);
  const maxSteps = smaller(asked['maxSteps'], budget.steps);
  const maxTotalTokens = smaller(asked['maxTotalTokens'], budget.tokens);
  const maxFailedAttempts = smaller(asked['maxFailedAttempts'], budget.retries);
  const timeoutMs = smaller(request.timeoutMs, budget.timeMs) ?? defaults.runTimeoutMs;
  if (delegated || maxCostUsd !== undefined) {
    const chain = await billing();
    if (maxCostUsd !== undefined && !chain.priced) {
      throw invalidRequest('a money limit is declared, but the model of this session, or a model it falls back to, has no price, so its cost cannot be counted; add its price under pricing, or run without a money limit', delegated ? 'mandate' : 'limits');
    }
    if (delegated && chain.metered && maxCostUsd === undefined) {
      throw invalidRequest('a mandate on a model billed by use needs a money budget: declare budget.costUsd (costUsd of the mandate in the user settings)', 'mandate');
    }
  }
  const { budget: _budget, ...stored } = mandate ?? {};
  return {
    ...(mandate === undefined ? {} : { mandate: stored }),
    limits: {
      ...defaults.limits,
      ...asked,
      ...(maxSteps === undefined ? {} : { maxSteps }),
      ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
      ...(maxFailedAttempts === undefined ? {} : { maxFailedAttempts }),
    },
    timeoutMs,
  };
};
