import type { DiffHunk } from '@momonga/protocol';

export const DIFF_CONTEXT_LINES = 3;
export const DIFF_MAX_BYTES = 256 * 1024;
export const DIFF_HUNK_TEXT_MAX_BYTES = 64 * 1024;
export const DIFF_FILE_TOO_LARGE = 'file larger than 256 KiB';
export const DIFF_TOO_LARGE = 'diff larger than 64 KiB';

export type AppliedDiff = { hunks?: DiffHunk[]; added?: number; removed?: number; diffOmitted?: string };

export type LineChange = { oldIndex: number; removed: readonly string[]; added: readonly string[] };

export type TextReplacement = { position: number; length: number; text: string };

const LINE_BREAK = /\r?\n/;

export const diffLinesOf = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split(LINE_BREAK);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const trimmed = (oldIndex: number, before: readonly string[], after: readonly string[]): LineChange | undefined => {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  return removed.length === 0 && added.length === 0 ? undefined : { oldIndex: oldIndex + prefix, removed, added };
};

type Hunked = { start: number; end: number; changes: LineChange[] };

const groupedByContext = (changes: readonly LineChange[], lineCount: number): Hunked[] => {
  const groups: Hunked[] = [];
  for (const change of changes) {
    const start = Math.max(0, change.oldIndex - DIFF_CONTEXT_LINES);
    const end = Math.min(lineCount, change.oldIndex + change.removed.length + DIFF_CONTEXT_LINES);
    const last = groups.at(-1);
    if (last !== undefined && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.changes.push(change);
    } else groups.push({ start, end, changes: [change] });
  }
  return groups;
};

export const diffOfChanges = (oldLines: readonly string[], changes: readonly LineChange[]): AppliedDiff => {
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let shift = 0;
  let room = DIFF_HUNK_TEXT_MAX_BYTES;
  let cut = false;
  for (const group of groupedByContext(changes, oldLines.length)) {
    const lines: string[] = [];
    const push = (sign: string, text: string): void => {
      const line = `${sign}${text}`;
      room -= Buffer.byteLength(line);
      if (room >= 0) lines.push(line);
      else cut = true;
    };
    const newStart = group.start + shift + 1;
    let cursor = group.start;
    for (const change of group.changes) {
      for (const text of oldLines.slice(cursor, change.oldIndex)) push(' ', text);
      for (const text of change.removed) push('-', text);
      for (const text of change.added) push('+', text);
      cursor = change.oldIndex + change.removed.length;
      added += change.added.length;
      removed += change.removed.length;
      shift += change.added.length - change.removed.length;
    }
    for (const text of oldLines.slice(cursor, group.end)) push(' ', text);
    if (lines.length > 0) hunks.push({ oldStart: group.start + 1, newStart, lines });
  }
  return { hunks, added, removed, ...(cut ? { diffOmitted: DIFF_TOO_LARGE } : {}) };
};

const lineStartOf = (text: string, position: number): number => text.lastIndexOf('\n', position - 1) + 1;

const lineEndOf = (text: string, position: number): number => {
  const end = text.indexOf('\n', position);
  return end === -1 ? text.length : end;
};

export const diffOfReplacements = (original: string, replacements: readonly TextReplacement[]): AppliedDiff => {
  const changes: LineChange[] = [];
  let counted = 0;
  let lineIndex = 0;
  for (let index = 0; index < replacements.length; ) {
    const first = replacements[index];
    if (first === undefined) break;
    const start = lineStartOf(original, first.position);
    let end = lineEndOf(original, first.position + first.length);
    let after = original.slice(start, first.position) + first.text;
    let cursor = first.position + first.length;
    index += 1;
    for (let next = replacements[index]; next !== undefined && next.position <= end; next = replacements[index]) {
      after += original.slice(cursor, next.position) + next.text;
      cursor = next.position + next.length;
      end = lineEndOf(original, cursor);
      index += 1;
    }
    after += original.slice(cursor, end);
    for (let at = original.indexOf('\n', counted); at !== -1 && at < start; at = original.indexOf('\n', at + 1)) lineIndex += 1;
    counted = start;
    const change = trimmed(lineIndex, original.slice(start, end).split(LINE_BREAK), after.split(LINE_BREAK));
    if (change !== undefined) changes.push(change);
  }
  return diffOfChanges(diffLinesOf(original), changes);
};

export const diffOfContents = (oldText: string | null, newText: string): AppliedDiff => {
  if (Buffer.byteLength(newText) > DIFF_MAX_BYTES || (oldText !== null && Buffer.byteLength(oldText) > DIFF_MAX_BYTES)) return { diffOmitted: DIFF_FILE_TOO_LARGE };
  const before = oldText === null ? [] : diffLinesOf(oldText);
  const change = trimmed(0, before, diffLinesOf(newText));
  return diffOfChanges(before, change === undefined ? [] : [change]);
};
