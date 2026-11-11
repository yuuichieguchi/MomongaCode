export type DiffLine = { kind: 'context' | 'removed' | 'added' | 'header'; text: string };

export const PROMPT_BORDER_LINES = 2;
export const PROMPT_TITLE_LINES = 1;
export const PROMPT_HINT_LINES = 1;
export const PROMPT_OMITTED_NOTICE_LINES = 1;
export const STATUS_LINE_LINES = 1;

export const maxDiffLines = (terminalRows: number, optionCount: number): number =>
  Math.max(0, terminalRows - PROMPT_BORDER_LINES - PROMPT_TITLE_LINES - optionCount - PROMPT_HINT_LINES - PROMPT_OMITTED_NOTICE_LINES - STATUS_LINE_LINES);

export const clipDiff = (lines: readonly DiffLine[], max: number): { lines: DiffLine[]; omitted: number } => ({
  lines: lines.slice(0, max),
  omitted: Math.max(0, lines.length - max),
});
