import { safeSlice } from '@momonga/foundation';
import type { BlobPort } from './ports.ts';

const MEDIA_TYPE = 'text/plain; charset=utf-8';
const SEPARATOR_COUNT = 2;

const MAX_OMITTED_DIGITS = 16;
const HANDLE_LENGTH = 64;
const HANDLE_PATTERN = new RegExp(`^[0-9a-f]{${HANDLE_LENGTH}}$`);

const markerText = (omitted: number | string, handle: string): string =>
  `[${omitted} lines omitted; full output saved as ${handle}; read it with the ReadOutput tool]`;

export const MINIMUM_INLINE_OUTPUT_CHARS =
  markerText('9'.repeat(MAX_OMITTED_DIGITS), 'f'.repeat(HANDLE_LENGTH)).length + SEPARATOR_COUNT + 2;

const headSlice = (text: string, length: number): string => safeSlice(text, 0, length);

const tailSlice = (text: string, length: number): string => (length <= 0 ? '' : safeSlice(text, text.length - length, text.length));

export type TruncatedOutput = { output: string } | { output: string; truncated: true; handle: string };

const takeHead = (lines: readonly string[], budget: number): string[] => {
  const taken: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + line.length + (taken.length === 0 ? 0 : 1);
    if (next > budget) break;
    taken.push(line);
    used = next;
  }
  return taken;
};

export const truncateOutput = (output: string, limit: number, blobs: BlobPort): TruncatedOutput => {
  if (output.length <= limit) return { output };
  const stored = blobs.put(output, { mediaType: MEDIA_TYPE });
  if (!HANDLE_PATTERN.test(stored.handle)) {
    throw new TypeError(`blob handle must be ${HANDLE_LENGTH} lowercase hex characters, got ${JSON.stringify(stored.handle)}`);
  }
  const lines = output.split('\n');
  const markerFor = (omitted: number): string => markerText(omitted, stored.handle);
  const budget = Math.max(0, limit - markerFor(lines.length).length - SEPARATOR_COUNT);
  const headBudget = Math.floor(budget / 2);

  const headLines = takeHead(lines, headBudget);
  const head = headLines.length > 0 ? headLines.join('\n') : headSlice(output, headBudget);
  const headUsed = head.length;

  const tailBudget = budget - headUsed;
  const tailLines = takeHead([...lines].reverse(), tailBudget).reverse();
  const tail = tailLines.length > 0 ? tailLines.join('\n') : tailSlice(output, tailBudget);

  const omitted = Math.max(0, lines.length - headLines.length - tailLines.length);
  const text = [head, markerFor(omitted), tail].filter((part) => part !== '').join('\n');
  return { output: text, truncated: true, handle: stored.handle };
};
