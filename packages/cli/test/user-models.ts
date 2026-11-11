import fs from 'node:fs';
import { resolveModels, serverRegistryOf } from '@momonga/config';
import type { ModelsSettings, ResolvedModel, UserModels } from '@momonga/config';
import { isRecord, momongaLayout } from '@momonga/foundation';

const SOURCE = 'settings';

export const userModelsOf = (models: unknown, extra: Omit<UserModels, 'resolved'> = {}): UserModels => {
  const declared = models as ModelsSettings;
  return { resolved: resolveModels(declared, { source: SOURCE, warnings: [], servers: serverRegistryOf(declared.servers, SOURCE) }), ...extra };
};

export const userModelsAt = (home: string): UserModels => {
  const file = momongaLayout(home, process.platform, process.env).settingsFile;
  const written: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return userModelsOf(isRecord(written) && isRecord(written['models']) ? written['models'] : {});
};

export const firstModelOf = (models: UserModels): ResolvedModel => {
  const [first] = models.resolved.models.values();
  if (first === undefined) throw new Error('the settings hold no model');
  return first;
};
