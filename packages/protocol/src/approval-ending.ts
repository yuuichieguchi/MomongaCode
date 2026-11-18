import type { PermissionOption } from './run-types.ts';
import type { Surface } from './vocabulary.ts';

export const SURFACE_NAMES: Readonly<Record<Surface, string>> = { tui: 'the terminal UI', cli: 'the command line', acp: 'an ACP client', gateway: 'the model server' };

const UNANSWERED_ENDINGS: Readonly<Record<'expired' | 'withdrawn' | 'superseded', string>> = {
  expired: 'expired',
  withdrawn: 'withdrawn: the run ended',
  superseded: 'superseded by a newer request',
};

export type ApprovalEndingFacts = { readonly status: string; readonly options: readonly PermissionOption[]; readonly optionId?: string; readonly resolvedBy?: string };

const isSurface = (value: string | undefined): value is Surface => value !== undefined && Object.hasOwn(SURFACE_NAMES, value);

export const answerText = (options: readonly PermissionOption[], optionId: string | undefined): string => {
  const option = options.find((candidate) => candidate.optionId === optionId);
  if (option === undefined) return optionId ?? 'an answer not recorded';
  return option.name === option.kind ? option.kind : `${option.kind} (${option.name})`;
};

export const approvalEndingText = (facts: ApprovalEndingFacts): string => {
  if (facts.status === 'resolved') return `resolved${isSurface(facts.resolvedBy) ? ` by ${SURFACE_NAMES[facts.resolvedBy]}` : ''}: ${answerText(facts.options, facts.optionId)}`;
  if (facts.status === 'expired' || facts.status === 'withdrawn' || facts.status === 'superseded') return UNANSWERED_ENDINGS[facts.status];
  return facts.status;
};
