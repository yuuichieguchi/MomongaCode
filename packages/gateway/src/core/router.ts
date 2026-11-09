import { aliasRoomVerdict } from '@momonga/config';
import type { AliasMember } from '@momonga/config';
import type { Clock } from '@momonga/foundation';
import { MOMONGA_REQUEST_FIELDS, PRECONDITION_FAILED_CODE, agentReadiness, applyCapabilityOverride, imageCapability, sizingRatioFor, summaryTokenCapFor } from '@momonga/protocol';
import type { AliasCapabilities, Capabilities, CapabilityOverride, ClientOperation, FunctionTool, ToolChoice, ToolCallingMode, ToolCallingState, GatewayHealth, HealthResult, ImageCapability, ProviderAdapter, TargetBilling, TargetHealth } from '@momonga/protocol';
import { constrainsToolChoice, resolveToolChoice } from './tool-choice.ts';
import { UnsupportedInputError } from './unsupported-input.ts';
import { createAdmissionGate } from './admission.ts';
import type { AdmissionGate } from './admission.ts';
import { preconditionText } from '../precondition-text.ts';
import { invalidRequest, notFound } from './errors.ts';
import { CandidateRefused, REFUSAL_STAGES, UnprobedTarget, refusalErrorOf } from './candidate-refusal.ts';
import type { Refusal } from './candidate-refusal.ts';
import { carriesSampling, samplingRefusalOf } from './sampling.ts';
import type { SamplingRequest } from './sampling.ts';
import { unknownParameterError } from './unknown-fields.ts';
import { TargetBreaker } from './request-breaker.ts';
import { guardAdapter } from './guarded-adapter.ts';
import type { ReasoningOriginCodec } from './reasoning-origin.ts';
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

export type UnknownFieldsRequirement = { keys: readonly string[]; operation: ClientOperation };

export type ToolChoiceRequirement = { tools: readonly FunctionTool[] | null | undefined; tool_choice: ToolChoice | null | undefined };

export type CandidateRequirements = {
  tools?: boolean;
  images?: boolean;
  sampling?: SamplingRequest;
  toolChoice?: ToolChoiceRequirement;
  summaryCap?: number;
  unknownFields?: UnknownFieldsRequirement;
};

export type Narrowed = { targets: TargetRuntime[]; refusals: Refusal[]; capabilitiesOf(target: TargetRuntime): Promise<Capabilities> };

export type Router = {
  aliases(): string[];
  hasAlias(alias: string): boolean;
  targetsOf(alias: string): TargetRuntime[];
  capabilitiesOf(target: TargetRuntime): Promise<Capabilities>;
  aliasCapabilitiesOf(alias: string): Promise<AliasCapabilities>;
  candidates(alias: string, requirements: CandidateRequirements): Promise<Narrowed>;
  narrow(alias: string, targets: readonly TargetRuntime[], requirements: CandidateRequirements): Promise<Narrowed>;
  health(): Promise<Pick<GatewayHealth, 'ok' | 'targets'>>;
};

export type RouterOptions = {
  config: GatewayConfig;
  adapters: Record<string, ProviderAdapter>;
  clock: Clock;
  timers: GatewayTimers;
  redactor: Redactor;
  reasoningOrigin: ReasoningOriginCodec;
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

const mergedSchemaDialect = (all: readonly [Capabilities, ...Capabilities[]]): Pick<AliasCapabilities, 'schemaDialect'> => {
  const [first] = all;
  return all.every((entry) => entry.schemaDialect === first.schemaDialect) ? { schemaDialect: first.schemaDialect } : {};
};

const mergedJsonMode = (all: readonly Capabilities[]): Pick<AliasCapabilities, 'jsonMode'> => {
  if (all.some((entry) => entry.jsonMode === undefined)) return {};
  return { jsonMode: all.some((entry) => entry.jsonMode === 'none') ? 'none' : 'json_object' };
};

const mergeCapabilities = (all: readonly [Capabilities, ...Capabilities[]]): AliasCapabilities => {
  const [first] = all;
  return {
    contextWindow: Math.min(...all.map((entry) => entry.contextWindow)),
    maxOutputTokens: Math.min(...all.map((entry) => entry.maxOutputTokens)),
    toolCalling: mergedToolCalling(all),
    structuredOutput: all.some((entry) => entry.structuredOutput === 'none') ? 'none' : 'json_schema',
    ...mergedJsonMode(all),
    streaming: all.every((entry) => entry.streaming),
    stopSequences: all.every((entry) => entry.stopSequences),
    ...mergedImageCapability(all),
    ...mergedParallelToolCalls(all),
    ...mergedSchemaDialect(all),
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
      adapter: guardAdapter(requireEntry(adapters, name, 'adapter'), options.redactor, options.reasoningOrigin),
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

  const roomMemberOf = async (target: TargetRuntime): Promise<AliasMember> => {
    const adapterTarget = { name: target.name, model: target.model };
    if (target.adapter.roomFacts !== undefined) return { target: target.name, measuring: false, ...(await target.adapter.roomFacts(adapterTarget)) };
    const capabilities = await capabilitiesOf(target);
    return { target: target.name, measuring: false, outputBounded: capabilities.outputBoundField !== 'none', contextWindow: capabilities.contextWindow, maxOutputTokens: capabilities.maxOutputTokens };
  };

  const checkAliasRoom = async (alias: string, members: readonly TargetRuntime[]): Promise<void> => {
    if (!members.some((member) => member.adapter.roomFacts !== undefined)) return;
    const verdict = aliasRoomVerdict(alias, await Promise.all(members.map(roomMemberOf)));
    if (verdict.kind === 'serve') return;
    if (verdict.kind === 'wait') throw new Error(`model alias "${alias}": every member was read with its values, yet the input room check asked to wait`);
    throw invalidRequest(PRECONDITION_FAILED_CODE, verdict.message, 'model', 412);
  };

  const aliasCapabilitiesOf = async (alias: string): Promise<AliasCapabilities> => {
    const all = await Promise.all(targetsOf(alias).map((target) => capabilitiesOf(target)));
    const [first, ...rest] = all;
    if (first === undefined) throw new Error(`model alias "${alias}" has no targets`);
    return mergeCapabilities([first, ...rest]);
  };

  const narrow = async (alias: string, all: readonly TargetRuntime[], requirements: CandidateRequirements): Promise<Narrowed> => {
    const memo = new Map<TargetRuntime, Promise<Capabilities>>();
    const verdicts = new Map<TargetRuntime, Refusal | undefined>();
    const resolve = (target: TargetRuntime): Promise<Capabilities> => {
      const known = memo.get(target);
      if (known !== undefined) return known;
      const started = capabilitiesOf(target);
      memo.set(target, started);
      started.catch(() => {
        if (memo.get(target) === started) memo.delete(target);
      });
      return started;
    };
    const { sampling } = requirements;
    const samples = sampling !== undefined && carriesSampling(sampling);
    const judge = (target: TargetRuntime, capabilities: Capabilities): Refusal | undefined => {
      if (requirements.tools === true) {
        const readiness = agentReadiness(capabilities);
        if (readiness.state === 'needs_probe') {
          throw new UnprobedTarget(invalidRequest(PRECONDITION_FAILED_CODE, preconditionText(readiness.message, readiness.evidence, readiness.remedy), null, 412));
        }
        if (readiness.state === 'no_tools') {
          return { stage: REFUSAL_STAGES.tools, error: invalidRequest('capability_unsupported', `no target of model alias "${alias}" supports tool calling`, 'tools') };
        }
      }
      if (requirements.images === true && !capabilities.imageInput) {
        return { stage: REFUSAL_STAGES.images, error: invalidRequest('capability_unsupported', `no target of model alias "${alias}" supports image input`, 'input') };
      }
      if (sampling !== undefined && samples) {
        const refusal = samplingRefusalOf(sampling, { name: target.name, kind: target.adapter.kind }, target.adapter.sampling, capabilities);
        if (refusal !== undefined) return { stage: REFUSAL_STAGES.sampling, error: invalidRequest('sampling_not_accepted', refusal.message, refusal.field) };
      }
      const { toolChoice } = requirements;
      if (toolChoice !== undefined && constrainsToolChoice(toolChoice.tool_choice) && agentReadiness(capabilities).state !== 'needs_probe') {
        try {
          resolveToolChoice(
            {
              model: target.model,
              input: [],
              ...(toolChoice.tools === null || toolChoice.tools === undefined ? {} : { tools: [...toolChoice.tools] }),
              ...(toolChoice.tool_choice === null || toolChoice.tool_choice === undefined ? {} : { tool_choice: toolChoice.tool_choice }),
            },
            capabilities.allowedTools,
            target.name,
            target.adapter.toolChoiceWire(capabilities, { name: target.name, model: target.model }),
          );
        } catch (error) {
          if (!(error instanceof UnsupportedInputError)) throw error;
          return { stage: REFUSAL_STAGES.toolChoice, error: invalidRequest(error.code, error.message, error.param) };
        }
      }
      const { summaryCap } = requirements;
      if (summaryCap !== undefined && Math.min(summaryTokenCapFor(capabilities), capabilities.maxOutputTokens) < summaryCap) {
        return {
          stage: REFUSAL_STAGES.summaryCap,
          error: invalidRequest(
            'invalid_summary_cap',
            `${MOMONGA_REQUEST_FIELDS.maxSummaryTokens} exceeds the largest summary any target of the model alias accepts: the smaller of its summary cap and its maxOutputTokens`,
            MOMONGA_REQUEST_FIELDS.maxSummaryTokens,
          ),
        };
      }
      const { unknownFields } = requirements;
      if (unknownFields !== undefined && unknownFields.keys.length > 0 && !target.adapter.relaysClientBody.includes(unknownFields.operation)) {
        return {
          stage: REFUSAL_STAGES.unknownFields,
          error: unknownParameterError(unknownFields.keys, alias, `no target of the alias relays a ${unknownFields.operation} request body upstream`),
        };
      }
      return undefined;
    };
    const capabilitiesForAttempt = async (target: TargetRuntime): Promise<Capabilities> => {
      const capabilities = await resolve(target);
      if (!verdicts.has(target)) verdicts.set(target, judge(target, capabilities));
      const refusal = verdicts.get(target);
      if (refusal !== undefined) throw new CandidateRefused(refusal);
      return capabilities;
    };
    const judging = requirements.tools === true || requirements.images === true || samples || constrainsToolChoice(requirements.toolChoice?.tool_choice) || requirements.summaryCap !== undefined || (requirements.unknownFields?.keys.length ?? 0) > 0;
    if (!judging) return { targets: [...all], refusals: [], capabilitiesOf: capabilitiesForAttempt };
    const resolved = await Promise.all(all.map((target) => resolve(target).catch(() => undefined)));
    const refusals: Refusal[] = [];
    const kept: TargetRuntime[] = [];
    all.forEach((target, index) => {
      const capabilities = resolved[index];
      if (capabilities === undefined) {
        kept.push(target);
        return;
      }
      let refusal: Refusal | undefined;
      try {
        refusal = judge(target, capabilities);
      } catch (error) {
        if (error instanceof UnprobedTarget) throw error.error;
        throw error;
      }
      verdicts.set(target, refusal);
      if (refusal === undefined) kept.push(target);
      else refusals.push(refusal);
    });
    if (kept.length === 0) throw refusalErrorOf(refusals);
    return { targets: kept, refusals, capabilitiesOf: capabilitiesForAttempt };
  };

  return {
    aliases: () => [...aliasTargets.keys()],
    hasAlias: (alias) => aliasTargets.has(alias),
    targetsOf,
    capabilitiesOf,
    aliasCapabilitiesOf,
    candidates: async (alias, requirements) => {
      const members = targetsOf(alias);
      await checkAliasRoom(alias, members);
      return narrow(alias, members, requirements);
    },
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
