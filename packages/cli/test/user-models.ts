import { resolveModels, serverRegistryOf } from '@momonga/config';
import type { ModelsSettings, ResolvedModel, UserModels } from '@momonga/config';

const SOURCE = 'settings';

export const userModelsOf = (models: unknown, extra: Omit<UserModels, 'resolved'> = {}): UserModels => {
  const declared = models as ModelsSettings;
  return { resolved: resolveModels(declared, { source: SOURCE, home: undefined, warnings: [], servers: serverRegistryOf(declared.servers, SOURCE) }), ...extra };
};

export const firstModelOf = (models: UserModels): ResolvedModel => {
  const [first] = models.resolved.models.values();
  if (first === undefined) throw new Error('the settings hold no model');
  return first;
};
