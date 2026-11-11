import { chainRoomVerdict, roomVerdictText } from '@momonga/config';
import type { ChainMember } from '@momonga/config';
import type { Clock } from '@momonga/foundation';
import {
  CHAIN_ROOM_REFUSED_CODE,
  MOMONGA_REQUEST_FIELDS,
  PRECONDITION_FAILED_CODE,
  agentReadiness,
  applyCapabilityOverride,
  displayMapOf,
  imageCapability,
  largestSummaryCapFor,
  isUnavailableCapabilities,
  modelRefErrorOf,
  resolveStoredModelRef,
  resolveTypedModelRef,
  sizingRatioFor,
  storedModelRef,
  typedModelText,
} from '@momonga/protocol';
import type {
  AdapterTarget,
  Capabilities,
  CapabilityOverride,
  ChainCapabilities,
  ClientOperation,
  FunctionTool,
  GatewayHealth,
  HealthResult,
  ImageCapability,
  InputKinds,
  ModelView,
  ModelViews,
  MomongaModelRoles,
  PlanAccountRef,
  ProviderAdapter,
  TargetAnswers,
  TargetBilling,
  TargetHealth,
  ToolCallingMode,
  ToolCallingState,
  ToolChoice,
} from '@momonga/protocol';
import { constrainsToolChoice, resolveToolChoice } from './tool-choice.ts';
import { UnsupportedInputError } from './unsupported-input.ts';
import { createAdmissionGate } from './admission.ts';
import type { AdmissionGate } from './admission.ts';
import { preconditionText } from '../precondition-text.ts';
import { ClientDisconnectedError, GatewayError, invalidRequest, notFound } from './errors.ts';
import { unavailableError } from './unavailable.ts';
import { plainError } from './retry.ts';
import { CandidateDropped, CandidateRefused, REFUSAL_STAGES, UnprobedTarget, refusalErrorOf } from './candidate-refusal.ts';
import type { Refusal } from './candidate-refusal.ts';
import { carriesSampling, samplingRefusalOf } from './sampling.ts';
import type { SamplingRequest } from './sampling.ts';
import { unknownParameterError } from './unknown-fields.ts';
import type { InputKindsRequirement } from './input.ts';
import type { BillingWalk } from './billing-walk.ts';
import { TargetBreaker } from './request-breaker.ts';
import { guardAdapter } from './guarded-adapter.ts';
import type { ReasoningOriginCodec } from './reasoning-origin.ts';
import type { GuardedAdapter } from './guarded-adapter.ts';
import type { Redactor } from './redaction.ts';
import type { GatewayConfig, GatewayTimers } from '../types.ts';

export type TargetRuntime = {
  name: string;
  display: string;
  kind: string;
  provider: string;
  model: string;
  defaultTag: string | undefined;
  answers: TargetAnswers;
  billing: TargetBilling;
  counter: string;
  adapter: GuardedAdapter;
  breaker: TargetBreaker;
  gate: AdmissionGate;
  capabilityOverride: CapabilityOverride | undefined;
  idempotencyKeyHeader: string | undefined;
  plan: PlanAccountRef | undefined;
  keyGroup: string | undefined;
  lastFailure: { code: string | null; message: string } | undefined;
  servedAccount: () => PlanAccountRef | undefined;
};

export type UnknownFieldsRequirement = { keys: readonly string[]; operation: ClientOperation };

export type ToolChoiceRequirement = { tools: readonly FunctionTool[] | null | undefined; tool_choice: ToolChoice | null | undefined };

export type CandidateRequirements = {
  tools?: boolean;
  images?: boolean;
  inputKinds?: InputKindsRequirement;
  sampling?: SamplingRequest;
  outputBound?: boolean;
  toolChoice?: ToolChoiceRequirement;
  summaryCap?: number;
  unknownFields?: UnknownFieldsRequirement;
};

export type Narrowed = { targets: TargetRuntime[]; refusals: Refusal[]; billing: BillingWalk; capabilitiesOf(target: TargetRuntime): Promise<Capabilities> };

export type Router = {
  models(): string[];
  hasModel(model: string): boolean;
  chainOf(model: string): TargetRuntime[];
  views(): ModelViews;
  displayOf(model: string): string;
  start(): string | null;
  roles(): MomongaModelRoles;
  resolveRequestModel(text: string, exact: boolean): string;
  capabilitiesOf(target: TargetRuntime): Promise<Capabilities>;
  roomRefusalOf(model: string, members: readonly TargetRuntime[]): Promise<GatewayError | undefined>;
  billingWalkOf(model: string): BillingWalk;
  candidates(model: string, requirements: CandidateRequirements): Promise<Narrowed>;
  narrow(model: string, targets: readonly TargetRuntime[], requirements: CandidateRequirements): Promise<Narrowed>;
  health(): Promise<Pick<GatewayHealth, 'ok' | 'models'>>;
  target(name: string): TargetRuntime | undefined;
};

export const adapterTargetOf = (target: Pick<TargetRuntime, 'name' | 'display' | 'model'>): AdapterTarget => ({ name: target.name, display: target.display, model: target.model });

export const resolveRequestModel = (text: string, exact: boolean, views: ModelViews): ModelView => {
  if (exact) {
    const stored = resolveStoredModelRef(storedModelRef(text), views);
    if (stored !== undefined) return stored;
    throw notFound('model_not_found', modelRefErrorOf(text, { kind: 'not_found' }, views, 'gateway').message, 'model');
  }
  const resolution = resolveTypedModelRef(typedModelText(text), views);
  if (resolution.kind === 'found') return resolution.model;
  const { message } = modelRefErrorOf(text, resolution, views, 'gateway');
  throw resolution.kind === 'ambiguous' ? invalidRequest('ambiguous_model', message, 'model') : notFound('model_not_found', message, 'model');
};

export type RouterOptions = {
  config: GatewayConfig;
  adapters: Record<string, ProviderAdapter>;
  clock: Clock;
  timers: GatewayTimers;
  redactor: Redactor;
  reasoningOrigin: ReasoningOriginCodec;
  previous?: Router;
  live?: readonly Router[];
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

const mergedSchemaDialect = (all: readonly [Capabilities, ...Capabilities[]]): Pick<ChainCapabilities, 'schemaDialect'> => {
  const [first] = all;
  return all.every((entry) => entry.schemaDialect === first.schemaDialect) ? { schemaDialect: first.schemaDialect } : {};
};

const mergedJsonMode = (all: readonly Capabilities[]): Pick<ChainCapabilities, 'jsonMode'> => {
  if (all.some((entry) => entry.jsonMode === undefined)) return {};
  return { jsonMode: all.some((entry) => entry.jsonMode === 'none') ? 'none' : 'json_object' };
};

const mergedOutputBound = (all: readonly Capabilities[]): Pick<ChainCapabilities, 'outputBoundField' | 'unboundedOutputTokens'> =>
  all.some((entry) => entry.outputBoundField === 'none') ? { outputBoundField: 'none', unboundedOutputTokens: Math.max(...all.map((entry) => entry.maxOutputTokens)) } : {};

const missingInputKind = (required: InputKindsRequirement, declared: InputKinds | undefined): { kind: string; param: string } | undefined => {
  if (declared === undefined) return undefined;
  const content = required.content.find((kind) => !declared.content.includes(kind));
  if (content !== undefined) return { kind: `${content} input`, param: 'input' };
  const tool = required.tools.find((kind) => !declared.tools.includes(kind));
  return tool === undefined ? undefined : { kind: `${tool} tools`, param: 'tools' };
};

const carriesInputKinds = (required: InputKindsRequirement | undefined): boolean => required !== undefined && (required.content.length > 0 || required.tools.length > 0);

export const mergeCapabilities = (all: readonly [Capabilities, ...Capabilities[]]): ChainCapabilities => {
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
    ...mergedOutputBound(all),
    source: first.source,
    ...(all.length === 1 && first.probedAt !== undefined ? { probedAt: first.probedAt } : {}),
  };
};

const reportedHealthOf = (target: TargetRuntime): Promise<HealthResult> | undefined =>
  target.adapter.health?.(adapterTargetOf(target));

export const createRouter = (options: RouterOptions): Router => {
  const { config, adapters, clock, timers } = options;
  const { targets: configured, chains: configuredChains, billingChanges = [] } = config.models;
  const views: ModelViews = Object.entries(configured).map(([canon, target]) => ({
    canon,
    provider: target.provider,
    ownName: target.model,
    ...(target.defaultTag === undefined ? {} : { defaultTag: target.defaultTag }),
  }));
  const displays = displayMapOf(views);
  const displayOf = (model: string): string => displays.get(model) ?? model;
  const targets = new Map<string, TargetRuntime>();
  for (const [name, target] of Object.entries(configured)) {
    const sameTarget = [options.previous, ...(options.live ?? [])]
      .map((router) => router?.target(name))
      .find((carried) => carried !== undefined && carried.counter === target.counter);
    const adapter = guardAdapter(requireEntry(adapters, name, 'adapter'), options.redactor, options.reasoningOrigin);
    const display = displayOf(name);
    targets.set(name, {
      name,
      display,
      kind: target.kind,
      provider: target.provider,
      model: target.model,
      defaultTag: target.defaultTag,
      answers: target.answers ?? 'model',
      billing: target.billing,
      counter: target.counter,
      adapter,
      breaker: sameTarget?.breaker ?? new TargetBreaker({ failureThreshold: config.breaker.failureThreshold, openMs: config.breaker.openMs, clock }),
      gate:
        sameTarget?.gate ??
        createAdmissionGate({
          display,
          maxConcurrency: target.maxConcurrency,
          admissionTimeoutMs: target.admissionTimeoutMs,
          timers,
        }),
      capabilityOverride: target.capabilities,
      idempotencyKeyHeader: target.idempotencyKeyHeader,
      plan: target.plan,
      keyGroup: target.keyGroup,
      lastFailure: undefined,
      servedAccount: () => adapter.servedAccount?.({ name, display, model: target.model }),
    });
  }
  const targetsByName = Object.fromEntries(targets);
  const chains = new Map<string, TargetRuntime[]>(
    Object.entries(configuredChains).map(([model, members]) => [model, [...new Set(members)].map((member) => requireEntry(targetsByName, member, 'model'))]),
  );

  const chainOf = (model: string): TargetRuntime[] => {
    const found = chains.get(model);
    if (found === undefined || found.length === 0) throw new Error(`model "${displayOf(model)}" has no models to try`);
    return found;
  };

  const capabilitiesOf = async (target: TargetRuntime): Promise<Capabilities> => {
    const reported = await target.adapter.capabilities(adapterTargetOf(target));
    const declared: Capabilities = target.idempotencyKeyHeader === undefined ? reported : { ...reported, idempotencyKey: { header: target.idempotencyKeyHeader } };
    if (target.capabilityOverride === undefined) return declared;
    return { ...applyCapabilityOverride(declared, target.capabilityOverride), source: 'config' };
  };

  const readRoomMember = async (target: TargetRuntime): Promise<ChainMember> => {
    if (target.adapter.roomFacts !== undefined) return { model: target.name, measuring: false, facts: await target.adapter.roomFacts(adapterTargetOf(target)) };
    const capabilities = await capabilitiesOf(target);
    return {
      model: target.name,
      measuring: false,
      facts: { outputBounded: capabilities.outputBoundField !== 'none', contextWindow: capabilities.contextWindow, maxOutputTokens: capabilities.maxOutputTokens },
    };
  };

  const roomMemberOf = async (target: TargetRuntime, first: boolean): Promise<ChainMember | undefined> => {
    try {
      return await readRoomMember(target);
    } catch (error) {
      if (error instanceof ClientDisconnectedError) throw error;
      if (error instanceof GatewayError) {
        if (first) throw error;
        return undefined;
      }
      throw plainError(target.adapter.classify(error));
    }
  };

  const roomRefusalOf = async (model: string, members: readonly TargetRuntime[]): Promise<GatewayError | undefined> => {
    if (!members.some((member) => member.adapter.roomFacts !== undefined)) return undefined;
    const read = await Promise.all(members.map((member, index) => roomMemberOf(member, index === 0)));
    const verdict = chainRoomVerdict(model, read.flatMap((member) => member ?? []));
    if (verdict.kind === 'serve') return undefined;
    if (verdict.kind === 'wait') throw new Error(`model "${displayOf(model)}": every model was read with its values, yet the input room check asked to wait`);
    return invalidRequest(CHAIN_ROOM_REFUSED_CODE, roomVerdictText(verdict.refusal, displayOf), 'model', 412);
  };

  const billingWalkOf = (model: string): BillingWalk => {
    const [first] = chainOf(model);
    if (first === undefined) throw new Error(`model "${displayOf(model)}" has no models to try`);
    return {
      initial: first.billing,
      allows: (from, to) => billingChanges.some((change) => change.from === from && change.to === to && (change.model === undefined || change.model === model)),
    };
  };

  const narrow = async (model: string, all: readonly TargetRuntime[], requirements: CandidateRequirements): Promise<Narrowed> => {
    const named = JSON.stringify(displayOf(model));
    const firstOfChain = chains.get(model)?.[0];
    const isFallbackMember = (target: TargetRuntime): boolean => target !== firstOfChain;
    const memo = new Map<TargetRuntime, Promise<Capabilities>>();
    const verdicts = new Map<TargetRuntime, Refusal | undefined>();
    const resolve = (target: TargetRuntime): Promise<Capabilities> => {
      const known = memo.get(target);
      if (known !== undefined) return known;
      const started = capabilitiesOf(target).catch((error: unknown) => {
        if (error instanceof GatewayError && isFallbackMember(target)) throw new CandidateDropped(error);
        throw error;
      });
      memo.set(target, started);
      started.catch(() => {
        if (memo.get(target) === started) memo.delete(target);
      });
      return started;
    };
    const { sampling } = requirements;
    const samples = sampling !== undefined && carriesSampling(sampling);
    const judge = (target: TargetRuntime, capabilities: Capabilities): Refusal | undefined => {
      if (isUnavailableCapabilities(capabilities)) throw new UnprobedTarget(unavailableError(capabilities.toolCalling));
      if (requirements.tools === true) {
        const readiness = agentReadiness(capabilities);
        if (readiness.state === 'needs_probe') {
          throw new UnprobedTarget(invalidRequest(PRECONDITION_FAILED_CODE, preconditionText(readiness.message, readiness.evidence, readiness.remedy), null, 412));
        }
        if (readiness.state === 'no_tools') {
          return { stage: REFUSAL_STAGES.tools, error: invalidRequest('capability_unsupported', `${named} and its fallback models do not support tool calling`, 'tools') };
        }
      }
      if (requirements.images === true && !capabilities.imageInput) {
        return { stage: REFUSAL_STAGES.images, error: invalidRequest('capability_unsupported', `${named} and its fallback models do not support image input`, 'input') };
      }
      const missing = requirements.inputKinds === undefined ? undefined : missingInputKind(requirements.inputKinds, capabilities.inputKinds);
      if (missing !== undefined) {
        return { stage: REFUSAL_STAGES.inputKinds, error: invalidRequest('capability_unsupported', `${named} and its fallback models do not accept ${missing.kind}`, missing.param) };
      }
      if (sampling !== undefined && samples) {
        const refusal = samplingRefusalOf(sampling, { name: target.display, kind: target.adapter.kind }, target.adapter.sampling, capabilities);
        if (refusal !== undefined) return { stage: REFUSAL_STAGES.sampling, error: invalidRequest('sampling_not_accepted', refusal.message, refusal.field) };
      }
      if (requirements.outputBound === true && capabilities.outputBoundField === 'none') {
        return { stage: REFUSAL_STAGES.outputBound, error: invalidRequest('capability_unsupported', `${named} and its fallback models carry no output bound`, 'max_output_tokens') };
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
            target.display,
            target.adapter.toolChoiceWire(capabilities, adapterTargetOf(target)),
          );
        } catch (error) {
          if (!(error instanceof UnsupportedInputError)) throw error;
          return { stage: REFUSAL_STAGES.toolChoice, error: invalidRequest(error.code, error.message, error.param) };
        }
      }
      const { summaryCap } = requirements;
      if (summaryCap !== undefined && largestSummaryCapFor(capabilities) < summaryCap) {
        return {
          stage: REFUSAL_STAGES.summaryCap,
          error: invalidRequest(
            'invalid_summary_cap',
            `${MOMONGA_REQUEST_FIELDS.maxSummaryTokens} exceeds the largest summary ${named} and its fallback models accept: the smaller of its summary cap and its maxOutputTokens`,
            MOMONGA_REQUEST_FIELDS.maxSummaryTokens,
          ),
        };
      }
      const { unknownFields } = requirements;
      if (unknownFields !== undefined && unknownFields.keys.length > 0 && !target.adapter.relaysClientBody.includes(unknownFields.operation)) {
        return {
          stage: REFUSAL_STAGES.unknownFields,
          error: unknownParameterError(unknownFields.keys, displayOf(model), `neither it nor its fallback models relay a ${unknownFields.operation} request body upstream`),
        };
      }
      return undefined;
    };
    const judged = (target: TargetRuntime, capabilities: Capabilities): Refusal | undefined => {
      try {
        return judge(target, capabilities);
      } catch (error) {
        if (error instanceof UnprobedTarget && isFallbackMember(target)) throw new CandidateDropped(error.error);
        throw error;
      }
    };
    const capabilitiesForAttempt = async (target: TargetRuntime): Promise<Capabilities> => {
      const capabilities = await resolve(target);
      if (!verdicts.has(target)) verdicts.set(target, judged(target, capabilities));
      const refusal = verdicts.get(target);
      if (refusal !== undefined) throw new CandidateRefused(refusal);
      return capabilities;
    };
    const billing = billingWalkOf(model);
    const judging = requirements.tools === true || requirements.images === true || carriesInputKinds(requirements.inputKinds) || requirements.outputBound === true || samples || constrainsToolChoice(requirements.toolChoice?.tool_choice) || requirements.summaryCap !== undefined || (requirements.unknownFields?.keys.length ?? 0) > 0;
    if (!judging) return { targets: [...all], refusals: [], billing, capabilitiesOf: capabilitiesForAttempt };
    const resolved = await Promise.all(all.map((target) => resolve(target).catch((error: unknown) => (error instanceof CandidateDropped ? error : undefined))));
    const refusals: Refusal[] = [];
    const kept: TargetRuntime[] = [];
    const dropped: GatewayError[] = [];
    all.forEach((target, index) => {
      const capabilities = resolved[index];
      if (capabilities === undefined) {
        kept.push(target);
        return;
      }
      if (capabilities instanceof CandidateDropped) {
        dropped.push(capabilities.error);
        return;
      }
      let refusal: Refusal | undefined;
      try {
        refusal = judged(target, capabilities);
      } catch (error) {
        if (error instanceof CandidateDropped) {
          dropped.push(error.error);
          return;
        }
        if (error instanceof UnprobedTarget) throw error.error;
        throw error;
      }
      verdicts.set(target, refusal);
      if (refusal === undefined) kept.push(target);
      else refusals.push(refusal);
    });
    const [firstDropped] = dropped;
    if (kept.length === 0 && firstDropped !== undefined) throw firstDropped;
    if (kept.length === 0) throw refusalErrorOf(refusals);
    return { targets: kept, refusals, billing, capabilitiesOf: capabilitiesForAttempt };
  };

  const start = config.models.start ?? views[0]?.canon ?? null;
  const roles = config.models.roles ?? {};

  return {
    target: (name) => targets.get(name),
    models: () => views.map((view) => view.canon),
    hasModel: (model) => targets.has(model),
    chainOf,
    views: () => views,
    displayOf,
    start: () => start,
    roles: () => roles,
    resolveRequestModel: (text, exact) => resolveRequestModel(text, exact, views).canon,
    capabilitiesOf,
    roomRefusalOf,
    billingWalkOf,
    candidates: async (model, requirements) => {
      const members = chainOf(model);
      const refusal = await roomRefusalOf(model, members);
      if (refusal !== undefined) throw refusal;
      return narrow(model, members, requirements);
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
      return { ok: entries.every(([, health]) => health.ok), models: Object.fromEntries(entries) };
    },
  };
};
