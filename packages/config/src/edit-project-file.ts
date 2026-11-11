import path from 'node:path';
import { hostPaths } from '@momonga/foundation';
import type { FileLockPorts } from '@momonga/foundation';
import { ConfigError } from './config-error.ts';
import { editUserSettings } from './edit-user-settings.ts';
import type { TrustOracle } from './layers.ts';
import { PROJECT_MANDATE_FILE, parseProjectMandate } from './project-mandate.ts';

export type ProjectMandateEdit = (document: Record<string, unknown>) => boolean;

export type EditProjectMandateOptions = { home: string; trust: TrustOracle; signal: AbortSignal; ports?: FileLockPorts; lockTimeoutMs?: number };

export const editProjectMandate = async (projectDir: string, edit: ProjectMandateEdit, { home, trust, signal, ports, lockTimeoutMs }: EditProjectMandateOptions): Promise<void> => {
  const file = path.join(projectDir, PROJECT_MANDATE_FILE);
  if (!(await trust.isTrusted(projectDir, signal))) throw new ConfigError(`${file}: the folder ${projectDir} is not trusted, so its mandate file is not written`);
  await editUserSettings(
    home,
    file,
    (document) => {
      if (!edit(document)) return false;
      parseProjectMandate(document, file);
      return true;
    },
    { signal, confine: { to: projectDir, paths: hostPaths(signal) }, ...(ports === undefined ? {} : { ports }), ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }) },
  );
};
