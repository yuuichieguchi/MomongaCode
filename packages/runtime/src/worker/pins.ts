import { MODEL_ROLES } from '@momonga/config';
import type { ModelRoles } from '@momonga/config';
import type { Capabilities } from '@momonga/protocol';
import { isRecord } from './json.ts';

export type RunPins = {
  modelAlias: string;
  systemPromptDigest: string;
  toolSetDigest: string;
  capabilities: Capabilities;
  roles: ModelRoles;
  memoryShare?: number;
  guidelineVersion?: number;
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

const isCapabilities = (value: unknown): value is Capabilities =>
  isRecord(value) &&
  typeof value['contextWindow'] === 'number' &&
  typeof value['maxOutputTokens'] === 'number' &&
  (value['parallelToolCalls'] === undefined || typeof value['parallelToolCalls'] === 'boolean') &&
  typeof value['streaming'] === 'boolean' &&
  typeof value['tokenCounting'] === 'string' &&
  typeof value['toolCalling'] === 'string';

export const readPins = (value: Record<string, unknown>): RunPins => {
  const { modelAlias, systemPromptDigest, toolSetDigest, capabilities, memoryShare, guidelineVersion } = value;
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
  return {
    modelAlias,
    systemPromptDigest,
    toolSetDigest,
    capabilities,
    roles: readRoles(value['roles']),
    ...(memoryShare === undefined ? {} : { memoryShare }),
    ...(guidelineVersion === undefined ? {} : { guidelineVersion }),
  };
};
