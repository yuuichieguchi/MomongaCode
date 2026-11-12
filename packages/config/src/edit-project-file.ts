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
  await approveProjectItems(home, projectDir, { mandate: written }, { lock, mechanism, random, signal });
};

export type ProjectItemsApproval = { hooks?: readonly string[]; mandate?: string };

export const approveProjectItems = async (home: string, projectDir: string, approval: ProjectItemsApproval, ports: SettingsWriterPorts): Promise<void> => {
  const folder = await hostPaths(ports.signal).canonicalPath(projectDir);
  await editUserSettings(layoutOf(home).settingsFile, (settings) => recordApproval(settings, folder, approval), ports);
};

const recordApproval = (settings: Record<string, unknown>, folder: string, approval: ProjectItemsApproval): boolean => {
  const approvals = isRecord(settings['projectApprovals']) ? settings['projectApprovals'] : {};
  const current = isRecord(approvals[folder]) ? approvals[folder] : {};
  const held = Array.isArray(current['hooks']) ? current['hooks'].filter((digest): digest is string => typeof digest === 'string') : [];
  const hooks = [...held, ...(approval.hooks ?? []).filter((digest, index, all) => !held.includes(digest) && all.indexOf(digest) === index)];
  const next = { ...current, ...(hooks.length === 0 ? {} : { hooks }), ...(approval.mandate === undefined ? {} : { mandate: approval.mandate }) };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  settings['projectApprovals'] = { ...approvals, [folder]: next };
  return true;
};
