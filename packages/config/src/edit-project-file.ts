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
  let written: { document: unknown; digest: string } | undefined;
  await editUserSettings(
    file,
    (document) => {
      if (!edit(document)) return false;
      parseProjectMandate(document, file);
      written = { document: structuredClone(document), digest: approvalDigestOf(document) };
      return true;
    },
    { lock, mechanism, random, signal, confine: { to: projectDir, paths } },
  );
  if (written === undefined) return;
  await approveProjectItems(home, projectDir, [{ kind: 'mandate', ...written }], { lock, mechanism, random, signal });
};

export type ApprovedItem = { kind: 'hook'; event: string; group: unknown; digest: string } | { kind: 'mandate'; document: unknown; digest: string };

export const approveProjectItems = async (home: string, projectDir: string, approved: readonly ApprovedItem[], ports: SettingsWriterPorts): Promise<void> => {
  const folder = await hostPaths(ports.signal).canonicalPath(projectDir);
  await editUserSettings(layoutOf(home).settingsFile, (settings) => recordApproval(settings, folder, approved), ports);
};

const recordApproval = (settings: Record<string, unknown>, folder: string, approved: readonly ApprovedItem[]): boolean => {
  const approvals = isRecord(settings['projectApprovals']) ? settings['projectApprovals'] : {};
  const current = isRecord(approvals[folder]) ? approvals[folder] : {};
  const held: unknown[] = Array.isArray(current['hooks']) ? current['hooks'] : [];
  const approvedHooks = approved.flatMap((item) => (item.kind === 'hook' ? [{ digest: item.digest, event: item.event, group: item.group }] : []));
  const heldDigest = (entry: unknown): unknown => (isRecord(entry) ? entry['digest'] : entry);
  const kept = held.map((entry) => approvedHooks.find((hook) => hook.digest === heldDigest(entry)) ?? entry);
  const added = approvedHooks.filter((hook, index) => !held.some((entry) => heldDigest(entry) === hook.digest) && approvedHooks.findIndex((other) => other.digest === hook.digest) === index);
  const hooks = [...kept, ...added];
  const mandate = approved.find((item) => item.kind === 'mandate');
  const next = { ...current, ...(hooks.length === 0 ? {} : { hooks }), ...(mandate === undefined ? {} : { mandate: { digest: mandate.digest, document: mandate.document } }) };
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  settings['projectApprovals'] = { ...approvals, [folder]: next };
  return true;
};
