import path from 'node:path';
import { hostPaths, isRecord } from '@momonga/foundation';
import { approvalDigestOf } from './approval-digest.ts';
import { layoutOf } from './layout.ts';
import { ConfigError } from './config-error.ts';
import { editUserSettings } from './edit-user-settings.ts';
import type { SettingsWriterPorts } from './file-lock.ts';
import type { TrustOracle } from './layers.ts';
import { PROJECT_MANDATE_FILE, parseProjectMandate } from './project-mandate.ts';

export type ProjectMandateEdit = (document: Record<string, unknown>) => boolean;

export type EditProjectMandateOptions = SettingsWriterPorts & { home: string; trust: TrustOracle };

export const editProjectMandate = async (projectDir: string, edit: ProjectMandateEdit, { home, trust, lock, mechanism, random, signal }: EditProjectMandateOptions): Promise<void> => {
  const file = path.join(projectDir, PROJECT_MANDATE_FILE);
  if (!(await trust.isTrusted(projectDir, signal))) throw new ConfigError(`${file}: the folder ${projectDir} is not trusted, so its mandate file is not written`);
  const paths = hostPaths(signal);
  let written: string | undefined;
  await editUserSettings(
    file,
    (document) => {
      if (!edit(document)) return false;
      parseProjectMandate(document, file);
      written = approvalDigestOf(document);
      return true;
    },
    { lock, mechanism, random, signal, confine: { to: projectDir, paths } },
  );
  if (written === undefined) return;
  const digest = written;
  const folder = await paths.canonicalPath(projectDir);
  await editUserSettings(layoutOf(home).settingsFile, (settings) => recordMandateApproval(settings, folder, digest), { lock, mechanism, random, signal });
};

const recordMandateApproval = (settings: Record<string, unknown>, folder: string, digest: string): boolean => {
  const approvals = isRecord(settings['projectApprovals']) ? settings['projectApprovals'] : {};
  const current = isRecord(approvals[folder]) ? approvals[folder] : {};
  if (current['mandate'] === digest) return false;
  settings['projectApprovals'] = { ...approvals, [folder]: { ...current, mandate: digest } };
  return true;
};
