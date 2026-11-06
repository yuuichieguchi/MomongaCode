import { MODEL_ROLES } from '@momonga/config';
import type { ModelRoles } from '@momonga/config';
import { OUTPUT_FORMATTERS, TARGET_ANSWERS, agentReadiness, isToolCallingState } from '@momonga/protocol';
import type { Capabilities, OutputFormatterName, TargetAnswers } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { isRecord } from './json.ts';

export type TokenPin = {
  cachePrefix?: boolean;
  deferred?: string[];
  conciseDescriptions?: boolean;
  outputFormatters?: OutputFormatterName[];
  loopGuidance?: boolean;
  observedCapacity?: boolean;
};

export type TargetPin = { adapter: string; model: string; answers?: TargetAnswers };

export type RunPins = {
  modelAlias: string;
  systemPromptDigest: string;
  toolSetDigest: string;
  capabilities: Capabilities;
  roles: ModelRoles;
  targets?: Record<string, TargetPin>;
  memoryShare?: number;
  guidelineVersion?: number;
  token?: TokenPin;
};

export const readRoles = (value: unknown): ModelRoles => {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('the roles pinned for this run are malformed');
  const roles: ModelRoles = {};
  for (const [role, alias] of Object.entries(value)) {
    if (!(MODEL_ROLES as readonly string[]).includes(role) || typeof alias !== 'string' || alias === '') {
      throw new Error('the roles pinned for this run are malformed');
    }
    roles[role as keyof ModelRoles] = alias;
  }
  return roles;
};

const isAnswers = (value: unknown): value is TargetAnswers => (TARGET_ANSWERS as readonly unknown[]).includes(value);

export const readTargets = (value: unknown): Record<string, TargetPin> => {
  if (!isRecord(value)) throw new Error('the targets pinned for this run are malformed');
  return Object.fromEntries(
    Object.entries(value).map(([name, pin]) => {
      if (!isRecord(pin) || typeof pin['adapter'] !== 'string' || typeof pin['model'] !== 'string' || (pin['answers'] !== undefined && !isAnswers(pin['answers']))) {
        throw new Error('the targets pinned for this run are malformed');
      }
      return [name, { adapter: pin['adapter'], model: pin['model'], ...(pin['answers'] === undefined ? {} : { answers: pin['answers'] }) }];
    }),
  );
};

const TOKEN_PIN_KEYS = ['cachePrefix', 'deferred', 'conciseDescriptions', 'outputFormatters', 'loopGuidance', 'observedCapacity'] as const;

const TOKEN_PIN_BOOLEANS = ['cachePrefix', 'conciseDescriptions', 'loopGuidance', 'observedCapacity'] as const;

const isFormatter = (value: unknown): value is OutputFormatterName => (OUTPUT_FORMATTERS as readonly unknown[]).includes(value);

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isFormatterArray = (value: unknown): value is OutputFormatterName[] => Array.isArray(value) && value.every(isFormatter);

export const readTokenPin = (value: unknown): TokenPin => {
  if (!isRecord(value) || Object.keys(value).some((key) => !(TOKEN_PIN_KEYS as readonly string[]).includes(key))) {
    throw new Error('the token pin recorded for this run is malformed');
  }
  const { deferred, outputFormatters } = value;
  if (
    TOKEN_PIN_BOOLEANS.some((key) => value[key] !== undefined && typeof value[key] !== 'boolean') ||
    (deferred !== undefined && !isStringArray(deferred)) ||
    (outputFormatters !== undefined && !isFormatterArray(outputFormatters))
  ) {
    throw new Error('the token pin recorded for this run is malformed');
  }
  return {
    ...Object.fromEntries(TOKEN_PIN_BOOLEANS.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])),
    ...(deferred === undefined ? {} : { deferred: [...deferred] }),
    ...(outputFormatters === undefined ? {} : { outputFormatters: [...outputFormatters] }),
  };
};

export const parentPinsOf = (store: Pick<RuntimeStore, 'readRunEventsOfTypes'>, runId: string): { modelAlias: string; roles: ModelRoles } => {
  const started = store.readRunEventsOfTypes(runId, ['run.started'])[0];
  if (started === undefined || started.type !== 'run.started') throw new Error(`run ${runId} has not recorded run.started, so it has pinned no model alias and no roles`);
  const modelAlias = started.pins['modelAlias'];
  if (typeof modelAlias !== 'string') throw new Error(`run ${runId} recorded run.started without a model alias pin`);
  return { modelAlias, roles: readRoles(started.pins['roles']) };
};

const isCapabilities = (value: unknown): value is Capabilities =>
  isRecord(value) &&
  typeof value['contextWindow'] === 'number' &&
  typeof value['maxOutputTokens'] === 'number' &&
  (value['parallelToolCalls'] === undefined || typeof value['parallelToolCalls'] === 'boolean') &&
  typeof value['streaming'] === 'boolean' &&
  typeof value['tokenCounting'] === 'string' &&
  isToolCallingState(value['toolCalling']);

export const readPins = (value: Record<string, unknown>): RunPins => {
  const { modelAlias, systemPromptDigest, toolSetDigest, capabilities, memoryShare, guidelineVersion, token } = value;
  if (
    typeof modelAlias !== 'string' ||
    typeof systemPromptDigest !== 'string' ||
    typeof toolSetDigest !== 'string' ||
    !isCapabilities(capabilities) ||
    (memoryShare !== undefined && typeof memoryShare !== 'number') ||
    (guidelineVersion !== undefined && (typeof guidelineVersion !== 'number' || !Number.isInteger(guidelineVersion) || guidelineVersion < 1))
  ) {
    throw new Error('the pins recorded for this run are malformed');
  }
  const readiness = agentReadiness(capabilities);
  if (readiness.state !== 'ready' && readiness.state !== 'no_tools') {
    throw new Error(`the pins recorded for this run hold capabilities of a target that was not ready: ${readiness.message}`);
  }
  return {
    modelAlias,
    systemPromptDigest,
    toolSetDigest,
    capabilities,
    roles: readRoles(value['roles']),
    ...(value['targets'] === undefined ? {} : { targets: readTargets(value['targets']) }),
    ...(memoryShare === undefined ? {} : { memoryShare }),
    ...(guidelineVersion === undefined ? {} : { guidelineVersion }),
    ...(token === undefined ? {} : { token: readTokenPin(token) }),
  };
};
