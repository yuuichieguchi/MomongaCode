import { TRUNCATION_MARKER_SOURCE, truncationMarker } from '@momonga/foundation';
import { TOOL_OUTPUT_TAG, fenceUntrusted } from '@momonga/protocol';
import type { FunctionCallOutputInputItem } from '@momonga/protocol';

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

export const outputTextOf = (output: FunctionCallOutputInputItem['output']): string =>
  typeof output === 'string'
    ? output
    : output.map((part) => ('text' in part ? part.text : 'refusal' in part ? part.refusal : '')).join('\n');

export const readClauseOf = (reader: string | undefined): string => (reader === undefined ? '' : `; read it with ${reader}`);

export const omittedMarker = (tokens: number, handle: string, reader: string | undefined): string =>
  `[tool output omitted: ${tokens} tokens; stored as ${handle}${readClauseOf(reader)}]`;

export const truncatedMarker = truncationMarker;

export const withOutput = (item: FunctionCallOutputInputItem, output: string): FunctionCallOutputInputItem => ({
  ...item,
  output,
});

const headOf = (text: string, length: number): string => {
  if (length <= 0) return '';
  const head = text.slice(0, length);
  const last = head.charCodeAt(head.length - 1);
  return last >= HIGH_SURROGATE_START && last <= HIGH_SURROGATE_END ? head.slice(0, -1) : head;
};

const tailOf = (text: string, length: number): string => {
  if (length <= 0) return '';
  const tail = text.slice(text.length - length);
  const first = tail.charCodeAt(0);
  return first >= LOW_SURROGATE_START && first <= LOW_SURROGATE_END ? tail.slice(1) : tail;
};

const MARKER_LINE = new RegExp(`^${TRUNCATION_MARKER_SOURCE}$`, 'm');

export type TokenCount = (text: string) => number | Promise<number>;

type CutSource = { head: string; tail: string; available: number; tokens: number | undefined };

const cutSourceOf = (text: string): CutSource => {
  const match = MARKER_LINE.exec(text);
  if (match === null) return { head: text, tail: text, available: text.length, tokens: undefined };
  const end = match.index + match[0].length;
  const head = match.index === 0 ? '' : text.slice(0, match.index - 1);
  const tail = end === text.length ? '' : text.slice(end + 1);
  return { head, tail, available: head.length + tail.length, tokens: Number(match[1]) };
};

export const cutChars = (text: string, keptChars: number, handle: string, tokens: number, reader: string | undefined): string => {
  const source = cutSourceOf(text);
  return [headOf(source.head, Math.ceil(keptChars / 2)), truncatedMarker(source.tokens ?? tokens, handle, reader), tailOf(source.tail, Math.floor(keptChars / 2))]
    .filter((part) => part !== '')
    .join('\n');
};

export type FitInput = { text: string; cap: number; handle: string; reader: string | undefined; count: TokenCount; onCut?: (keptChars: number) => void };

export const fitToTokens = async (input: FitInput): Promise<string> => {
  const { text, cap, handle, reader, count, onCut } = input;
  const total = await count(text);
  if (total <= cap) return text;
  let keptChars = Math.floor((cutSourceOf(text).available * cap) / total);
  for (;;) {
    const cut = cutChars(text, keptChars, handle, total, reader);
    const tokens = await count(cut);
    if (tokens <= cap || keptChars === 0) {
      onCut?.(keptChars);
      return cut;
    }
    keptChars = Math.max(0, Math.min(keptChars - 1, Math.floor((keptChars * cap) / tokens)));
  }
};

export type OutputRender = { full: FunctionCallOutputInputItem; enclose: (content: string) => string };

export const outputRenderOf = (original: FunctionCallOutputInputItem, tool: string | undefined, harnessTools: ReadonlySet<string>, pointer: boolean, sessionBoundary: string): OutputRender => {
  if (pointer || (tool !== undefined && harnessTools.has(tool))) return { full: original, enclose: (content) => content };
  const enclose = (content: string): string => fenceUntrusted(TOOL_OUTPUT_TAG, { call: original.call_id, tool: tool ?? '' }, content, sessionBoundary);
  return { full: withOutput(original, enclose(outputTextOf(original.output))), enclose };
};
