import { envelopeOf } from '@momonga/protocol';
import type { FunctionCallOutputInputItem } from '@momonga/protocol';

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

export const outputTextOf = (output: FunctionCallOutputInputItem['output']): string =>
  typeof output === 'string'
    ? output
    : output.map((part) => ('text' in part ? part.text : 'refusal' in part ? part.refusal : '')).join('\n');

export const HANDLE_READER_TOOL = 'ReadOutput';

export const omittedMarker = (tokens: number, handle: string): string =>
  `[tool output omitted: ${tokens} tokens; stored as ${handle}; read it with ${HANDLE_READER_TOOL}]`;

export const truncatedMarker = (tokens: number, handle: string): string =>
  `[… ${tokens} tokens omitted; full output stored as ${handle}; read it with ${HANDLE_READER_TOOL} …]`;

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

export const headAndTail = (text: string, keptChars: number, marker: string): string =>
  [headOf(text, Math.ceil(keptChars / 2)), marker, tailOf(text, Math.floor(keptChars / 2))]
    .filter((part) => part !== '')
    .join('\n');

export type OutputRender = { full: FunctionCallOutputInputItem; enclose: (content: string) => string };

export const outputRenderOf = (original: FunctionCallOutputInputItem, tool: string | undefined, harnessTools: ReadonlySet<string>, pointer: boolean): OutputRender => {
  if (pointer || (tool !== undefined && harnessTools.has(tool))) return { full: original, enclose: (content) => content };
  const enclose = (content: string): string => envelopeOf({ content, callId: original.call_id, tool: tool ?? '' });
  return { full: withOutput(original, enclose(outputTextOf(original.output))), enclose };
};
