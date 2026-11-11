import { displayToolPathSync, isRecord, resolveToolPath } from '@momonga/foundation';

export type DiffLine = { kind: 'context' | 'removed' | 'added' | 'header'; text: string };

const POSIX_UNIFIED_DIFF_CONTEXT_LINES = 3;

export const CONTEXT_LINES = POSIX_UNIFIED_DIFF_CONTEXT_LINES;

export const PROMPT_BORDER_LINES = 2;
export const PROMPT_TITLE_LINES = 1;
export const PROMPT_HINT_LINES = 1;
export const PROMPT_OMITTED_NOTICE_LINES = 1;
export const STATUS_LINE_LINES = 1;

export const maxDiffLines = (terminalRows: number, optionCount: number): number =>
  Math.max(0, terminalRows - PROMPT_BORDER_LINES - PROMPT_TITLE_LINES - optionCount - PROMPT_HINT_LINES - PROMPT_OMITTED_NOTICE_LINES - STATUS_LINE_LINES);

const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'));

export const diffOfStrings = (oldText: string, newText: string): DiffLine[] => {
  const before = linesOf(oldText);
  const after = linesOf(newText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return [
    ...before.slice(Math.max(0, prefix - CONTEXT_LINES), prefix).map((text): DiffLine => ({ kind: 'context', text })),
    ...before.slice(prefix, before.length - suffix).map((text): DiffLine => ({ kind: 'removed', text })),
    ...after.slice(prefix, after.length - suffix).map((text): DiffLine => ({ kind: 'added', text })),
    ...before.slice(before.length - suffix, before.length - suffix + CONTEXT_LINES).map((text): DiffLine => ({ kind: 'context', text })),
  ];
};

export const diffOfToolInput = (name: string, rawInput: unknown, workingDirectory: string): DiffLine[] | undefined => {
  if (!isRecord(rawInput)) return undefined;
  const filePath = rawInput['file_path'];
  if (typeof filePath !== 'string') return undefined;
  const header: DiffLine = { kind: 'header', text: displayToolPathSync(workingDirectory, resolveToolPath(workingDirectory, filePath)) };
  if (name === 'Edit') {
    const oldString = rawInput['old_string'];
    const newString = rawInput['new_string'];
    if (typeof oldString !== 'string' || typeof newString !== 'string') return undefined;
    return [header, ...diffOfStrings(oldString, newString)];
  }
  if (name === 'Write') {
    const content = rawInput['content'];
    if (typeof content !== 'string') return undefined;
    return [header, ...diffOfStrings('', content)];
  }
  return undefined;
};

export const clipDiff = (lines: readonly DiffLine[], max: number): { lines: DiffLine[]; omitted: number } => ({
  lines: lines.slice(0, max),
  omitted: Math.max(0, lines.length - max),
});
