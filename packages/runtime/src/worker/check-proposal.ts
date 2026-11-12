import { acceptedCheckOf, declaredChecksOf } from '@momonga/config';
import type { DeclaredCheck, ResolvedSettings } from '@momonga/config';
import { hostPaths } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';

export type CheckProposal = { readonly ask: false } | { readonly ask: true; readonly checks: readonly DeclaredCheck[] };

const NO_QUESTION: CheckProposal = { ask: false };

export const checkProposalOf = async (input: {
  projectDir: string;
  trusted: boolean;
  settings: ResolvedSettings;
  files?: FileSystem;
  signal: AbortSignal;
}): Promise<CheckProposal> => {
  const { trusted, settings, files, signal } = input;
  if (!trusted || settings.verification.conditions.length > 0) return NO_QUESTION;
  const folder = await hostPaths(signal).canonicalPath(input.projectDir);
  if (acceptedCheckOf(settings, folder) !== undefined) return NO_QUESTION;
  const checks = await declaredChecksOf(folder, files, signal);
  return checks.length === 0 ? NO_QUESTION : { ask: true, checks };
};
