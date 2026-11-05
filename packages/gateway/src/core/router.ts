import type { Clock } from '@momonga/foundation';
import { applyCapabilityOverride, imageCapability, sizingRatioFor } from '@momonga/protocol';
import type { Capabilities, CapabilityOverride, ToolCallingMode, ToolCallingState, GatewayHealth, HealthResult, ImageCapability, ProviderAdapter, TargetBilling, TargetHealth } from '@momonga/protocol';
import { createAdmissionGate } from './admission.ts';
import type { AdmissionGate } from './admission.ts';
import { preconditionText } from '../precondition-text.ts';
import { invalidRequest, notFound } from './errors.ts';
import { TargetBreaker } from './request-breaker.ts';
import { guardAdapter } from './guarded-adapter.ts';
import type { GuardedAdapter } from './guarded-adapter.ts';
import type { Redactor } from './redaction.ts';
import type { GatewayConfig, GatewayTimers } from '../types.ts';

export type TargetRuntime = {
  name: string;
  provider: string;
  model: string;
  billing: TargetBilling;
  counter: string;
  adapter: GuardedAdapter;
  breaker: TargetBreaker;
  gate: AdmissionGate;
  capabilityOverride: CapabilityOverride | undefined;
  lastFailure: { code: string | null; message: string } | undefined;
};

export type CandidateRequirements = { tools?: boolean; images?: boolean };

export type Router = {
  aliases(): string[];
  hasAlias(alias: string): boolean;
  targetsOf(alias: string): TargetRuntime[];
  capabilitiesOf(target: TargetRuntime): Promise<Capabilities>;
  aliasCapabilitiesOf(alias: string): Promise<Capabilities>;
  candidates(alias: string, requirements: CandidateRequirements): Promise<TargetRuntime[]>;
  narrow(alias: string, targets: readonly TargetRuntime[], requirements: CandidateRequirements): Promise<TargetRuntime[]>;
  health(): Promise<Pick<GatewayHealth, 'ok' | 'targets'>>;
};

export type RouterOptions = {
  config: GatewayConfig;
  adapters: Record<string, ProviderAdapter>;
  clock: Clock;
  timers: GatewayTimers;
  redactor: Redactor;
};

const requireEntry = <T>(entries: Record<string, T>, name: string, kind: string): T => {
  const entry = Object.hasOwn(entries, name) ? entries[name] : undefined;
  if (entry === undefined) throw new Error(`gateway configuration references unknown ${kind} "${name}"`);
  return entry;
};

const TOOL_CALLING_RANK: Record<ToolCallingMode, number> = { none: 0, constrained: 1, native: 2 };
const TOKEN_COUNTING_RANK: Record<Capabilities['tokenCounting'], number> = { estimated: 0, calibrated: 1, exact: 2 };

const weakest = <T extends string>(values: readonly T[], rank: Record<T, number>): T =>
  values.reduce((lowest, value) => (rank[value] < rank[lowest] ? value : lowest));

const mergedErrorRatio = (all: readonly Capabilities[]): Pick<Capabilities, 'tokenErrorRatio'> =>
  all.some((entry) => entry.tokenErrorRatio !== undefined) ? { tokenErrorRatio: Math.max(...all.map(sizingRatioFor)) } : {};

const mergedImageCapability = (all: readonly Capabilities[]): ImageCapability => {
  const models = all.flatMap((entry) => (entry.imageTokens === undefined ? [] : [entry.imageTokens]));
  if (models.length !== all.length) return imageCapability(false, undefined);
  return imageCapability(true, {
    pixelsPerToken: Math.min(...models.map((model) => model.pixelsPerToken)),
    maxTokens: Math.max(...models.map((model) => model.maxTokens)),
    minTokens: Math.max(...models.map((model) => model.minTokens)),
  });
};

const mergedParallelToolCalls = (all: readonly Capabilities[]): Pick<Capabilities, 'parallelToolCalls'> => {
  if (all.some((entry) => entry.parallelToolCalls === false)) return { parallelToolCalls: false };
  return all.every((entry) => entry.parallelToolCalls === true) ? { parallelToolCalls: true } : {};
};

const mergedToolCalling = (all: readonly Capabilities[]): ToolCallingState => {
  const modes: ToolCallingMode[] = [];
  for (const entry of all) {
    if (typeof entry.toolCalling !== 'string') return entry.toolCalling;
    modes.push(entry.toolCalling);
  }
  return weakest(modes, TOOL_CALLING_RANK);
};

const mergeCapabilities = (all: readonly [Capabilities, ...Capabilities[]]): Capabilities => {
  const [first] = all;
  return {
    contextWindow: Math.min(...all.map((entry) => entry.contextWindow)),
    maxOutputTokens: Math.min(...all.map((entry) => entry.maxOutputTokens)),
    toolCalling: mergedToolCalling(all),
    structuredOutput: all.some((entry) => entry.structuredOutput === 'none') ? 'none' : 'json_schema',
    streaming: all.every((entry) => entry.streaming),
    stopSequences: all.every((entry) => entry.stopSequences),
    ...mergedImageCapability(all),
    ...mergedParallelToolCalls(all),
    schemaDialect: all.some((entry) => entry.schemaDialect === 'guided-generation') ? 'guided-generation' : 'json-schema-2020-12',
    tokenCounting: weakest(all.map((entry) => entry.tokenCounting), TOKEN_COUNTING_RANK),
    ...mergedErrorRatio(all),
    usageReported: all.every((entry) => entry.usageReported),
    maxConcurrency: Math.min(...all.map((entry) => entry.maxConcurrency)),
    source: first.source,
    ...(all.length === 1 && first.probedAt !== undefined ? { probedAt: first.probedAt } : {}),
  };
};

const reportedHealthOf = (target: TargetRuntime): Promise<HealthResult> | undefined =>
  target.adapter.health?.({ name: target.name, model: target.model });

export const createRouter = (options: RouterOptions): Router => {
  const { config, adapters, clock, timers } = options;
  const targets = new Map<string, TargetRuntime>();
  for (const [name, target] of Object.entries(config.models.targets)) {
    targets.set(name, {
      name,
      provider: target.provider,
      model: target.model,
      billing: target.billing,
      counter: target.counter,
      adapter: guardAdapter(requireEntry(adapters, name, 'adapter'), options.redactor),
      breaker: new TargetBreaker({ failureThreshold: config.breaker.failureThreshold, openMs: config.breaker.openMs, clock }),
      gate: createAdmissionGate({
        targetName: name,
        maxConcurrency: target.maxConcurrency,
        admissionTimeoutMs: target.admissionTimeoutMs,
        timers,
      }),
      capabilityOverride: target.capabilities,
      lastFailure: undefined,
    });
  }
  const targetsByName = Object.fromEntries(targets);
  const aliasTargets = new Map<string, TargetRuntime[]>(
    Object.entries(config.models.aliases).map(([alias, names]) => [alias, names.map((name) => requireEntry(targetsByName, name, 'target'))]),
  );

  const targetsOf = (alias: string): TargetRuntime[] => {
    const found = aliasTargets.get(alias);
    if (found === undefined) throw notFound('model_not_found', `model alias "${alias}" is not configured`, 'model');
    return found;
  };

  const capabilitiesOf = async (target: TargetRuntime): Promise<Capabilities> => {
    const declared = await target.adapter.capabilities({ name: target.name, model: target.model });
    if (target.capabilityOverride === undefined) return declared;
    return { ...applyCapabilityOverride(declared, target.capabilityOverride), source: 'config' };
  };

  const aliasCapabilitiesOf = async (alias: string): Promise<Capabilities> => {
    const all = await Promise.all(targetsOf(alias).map((target) => capabilitiesOf(target)));
    const [first, ...rest] = all;
    if (first === undefined) throw new Error(`model alias "${alias}" has no targets`);
    return mergeCapabilities([first, ...rest]);
  };

  const narrow = async (alias: string, all: readonly TargetRuntime[], requirements: CandidateRequirements): Promise<TargetRuntime[]> => {
    let remaining = [...all];
    if (requirements.tools === true) {
      const capabilities = await Promise.all(remaining.map((target) => capabilitiesOf(target)));
      for (const { toolCalling } of capabilities) {
        if (typeof toolCalling !== 'string') throw invalidRequest('precondition_failed', preconditionText(toolCalling.message, toolCalling.evidence, toolCalling.remedy), null, 412);
      }
      remaining = remaining.filter((_, index) => (capabilities[index] as Capabilities).toolCalling !== 'none');
      if (remaining.length === 0) {
        throw invalidRequest('capability_unsupported', `no target of model alias "${alias}" supports tool calling`, 'tools');
      }
    }
    if (requirements.images === true) {
      const capabilities = await Promise.all(remaining.map((target) => capabilitiesOf(target)));
      remaining = remaining.filter((_, index) => (capabilities[index] as Capabilities).imageInput);
      if (remaining.length === 0) {
        throw invalidRequest('capability_unsupported', `no target of model alias "${alias}" supports image input`, 'input');
      }
    }
    return remaining;
  };

  return {
    aliases: () => [...aliasTargets.keys()],
    hasAlias: (alias) => aliasTargets.has(alias),
    targetsOf,
    capabilitiesOf,
    aliasCapabilitiesOf,
    candidates: (alias, requirements) => narrow(alias, targetsOf(alias), requirements),
    narrow,
    health: async () => {
      const entries = await Promise.all(
        [...targets.values()].map(async (target) => {
          const breaker = target.breaker.state;
          const reported = await reportedHealthOf(target);
          const health: TargetHealth = {
            ok: breaker !== 'open' && (reported?.ok ?? true),
            breaker,
            ...(reported?.reason === undefined ? {} : { reason: reported.reason }),
            ...(reported?.detail === undefined ? {} : { detail: reported.detail }),
            ...(reported?.remediation === undefined ? {} : { remediation: reported.remediation }),
          };
          return [target.name, health] as const;
        }),
      );
      return { ok: entries.every(([, health]) => health.ok), targets: Object.fromEntries(entries) };
    },
  };
};
