import path from 'node:path';
import { hostPaths } from '@momonga/foundation';
import { ConfigError } from './config-error.ts';
import { editUserSettings } from './edit-user-settings.ts';
import type { SettingsWriterPorts } from './file-lock.ts';
import type { TrustOracle } from './layers.ts';
import { PROJECT_MANDATE_FILE, parseProjectMandate } from './project-mandate.ts';

export type ProjectMandateEdit = (document: Record<string, unknown>) => boolean;

export type EditProjectMandateOptions = SettingsWriterPorts & { trust: TrustOracle };

export const editProjectMandate = async (projectDir: string, edit: ProjectMandateEdit, { trust, lock, mechanism, random, signal }: EditProjectMandateOptions): Promise<void> => {
  const file = path.join(projectDir, PROJECT_MANDATE_FILE);
  if (!(await trust.isTrusted(projectDir, signal))) throw new ConfigError(`${file}: the folder ${projectDir} is not trusted, so its mandate file is not written`);
  await editUserSettings(
    file,
    (document) => {
      if (!edit(document)) return false;
      parseProjectMandate(document, file);
      return true;
    },
    { lock, mechanism, random, signal, confine: { to: projectDir, paths: hostPaths(signal) } },
  );
};
