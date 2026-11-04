import { HISTORY_OUTPUT_HEAD_CHARS, HISTORY_OUTPUT_TAIL_CHARS } from '@momonga/foundation';
import { FAILURE_MARKERS } from './invariants.ts';

type Entry = { text: string; count: number; failure: boolean };

const isFailureLine = (line: string): boolean => FAILURE_MARKERS.some((marker) => line.includes(marker));

const collapsed = (lines: readonly string[]): Entry[] => {
  const entries: Entry[] = [];
  for (const line of lines) {
    const last = entries.at(-1);
    if (last !== undefined && last.text === line && line !== '') last.count += 1;
    else entries.push({ text: line, count: 1, failure: false });
  }
  return entries;
};

const markFailureBlocks = (entries: readonly Entry[]): void => {
  let start = 0;
  while (start < entries.length) {
    let end = start;
    while (end < entries.length && (entries[end] as Entry).text !== '') end += 1;
    const block = entries.slice(start, end);
    if (block.some((entry) => isFailureLine(entry.text))) {
      for (const entry of block) entry.failure = true;
      if (start > 0) (entries[start - 1] as Entry).failure = true;
      if (end < entries.length) (entries[end] as Entry).failure = true;
    }
    start = end + 1;
  }
};

const renderedText = (entry: Entry): string => (entry.count > 1 ? `${entry.text} [×${entry.count}]` : entry.text);

const headEnd = (entries: readonly Entry[]): number => {
  let used = 0;
  let end = 0;
  for (const entry of entries) {
    used += renderedText(entry).length + 1;
    if (used > HISTORY_OUTPUT_HEAD_CHARS) break;
    end += 1;
  }
  return end;
};

const tailStart = (entries: readonly Entry[]): number => {
  let used = 0;
  let start = entries.length;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    used += renderedText(entries[index] as Entry).length + 1;
    if (used > HISTORY_OUTPUT_TAIL_CHARS) break;
    start = index;
  }
  return start;
};

export const formatLog = (raw: string): string => {
  const entries = collapsed(raw.split('\n'));
  markFailureBlocks(entries);
  const keptHead = headEnd(entries);
  const keptTail = tailStart(entries);
  const kept = entries.map((entry, index) => entry.failure || index < keptHead || index >= keptTail);
  const output: string[] = [];
  let index = 0;
  while (index < entries.length) {
    if (kept[index] === true) {
      output.push(renderedText(entries[index] as Entry));
      index += 1;
      continue;
    }
    let end = index;
    while (end < entries.length && kept[end] !== true) end += 1;
    const run = entries.slice(index, end);
    const omitted = run.reduce((sum, entry) => sum + entry.count, 0);
    if (run.length === 1 && omitted === 1) output.push((run[0] as Entry).text);
    else output.push(`[${omitted} lines omitted]`);
    index = end;
  }
  return output.join('\n');
};
