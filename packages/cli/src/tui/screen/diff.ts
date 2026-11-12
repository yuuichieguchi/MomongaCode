import type { DiffHunk } from '@momonga/protocol';
import type { StyleToken } from './tokens.ts';

export const DIFF_PREVIEW_ROWS = 40;
export const HUNK_SEPARATOR = '⋮';
export const BLOCK_INDENT = '  ';

export type AppliedDiff = { path: string; hunks: readonly DiffHunk[]; added: number; removed: number; omitted?: string } | { path: string; hunks?: undefined; omitted: string };

export type ViewLine = { prefix: string; text: string; token?: StyleToken; continued?: boolean };

export type DiffFields = { hunks?: readonly DiffHunk[]; added?: number; removed?: number; diffOmitted?: string };

export const appliedDiffOf = (path: string, fields: DiffFields): AppliedDiff | undefined => {
  const { hunks, added, removed, diffOmitted } = fields;
  if (hunks !== undefined && added !== undefined && removed !== undefined) return { path, hunks, added, removed, ...(diffOmitted === undefined ? {} : { omitted: diffOmitted }) };
  return diffOmitted === undefined ? undefined : { path, omitted: diffOmitted };
};

export const omittedText = (reason: string): string => `(diff omitted: ${reason})`;

export const diffHeader = (diff: AppliedDiff): string => `• Edited ${diff.path} ${diff.hunks === undefined ? omittedText(diff.omitted) : `(+${diff.added} -${diff.removed})`}`;

export const diffRowCount = (hunks: readonly DiffHunk[]): number => hunks.reduce((count, hunk) => count + hunk.lines.length, Math.max(0, hunks.length - 1));

const lastNumberOf = (hunk: DiffHunk): number => {
  let old = hunk.oldStart - 1;
  let fresh = hunk.newStart - 1;
  for (const line of hunk.lines) {
    if (!line.startsWith('+')) old += 1;
    if (!line.startsWith('-')) fresh += 1;
  }
  return Math.max(old, fresh);
};

export type DiffRow = { text: string; token?: StyleToken; first: string };

export const diffRows = (hunks: readonly DiffHunk[]): DiffRow[] => [...diffLines(hunks)].map((line) => ({ text: line.text, ...(line.token === undefined ? {} : { token: line.token }), first: line.prefix }));

export function* diffLines(hunks: readonly DiffHunk[]): Generator<ViewLine> {
  const digits = String(hunks.reduce((highest, hunk) => Math.max(highest, lastNumberOf(hunk)), 1)).length;
  let first = true;
  for (const hunk of hunks) {
    if (!first) yield { prefix: BLOCK_INDENT, text: HUNK_SEPARATOR, token: 'dim' };
    first = false;
    let old = hunk.oldStart;
    let fresh = hunk.newStart;
    for (const line of hunk.lines) {
      const sign = line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : ' ';
      const number = sign === '-' ? old : fresh;
      if (sign !== '+') old += 1;
      if (sign !== '-') fresh += 1;
      yield { prefix: `${BLOCK_INDENT}${String(number).padStart(digits)} ${sign}`, text: line.slice(1), ...(sign === '+' ? { token: 'diff.added' as const } : sign === '-' ? { token: 'diff.removed' as const } : {}) };
    }
  }
}
