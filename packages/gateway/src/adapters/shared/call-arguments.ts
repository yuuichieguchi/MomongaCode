import { isRecord } from '@momonga/foundation';
import type { AdapterInputItem } from '@momonga/protocol';
import { fenceUntrusted } from '@momonga/protocol';
import { boundaryOf } from './input-text.ts';
import { usableUpstreamJson } from './upstream-json.ts';

const parsedObjectOf = (text: string): Record<string, unknown> | undefined => {
  const parsed = usableUpstreamJson(text);
  return isRecord(parsed) ? parsed : undefined;
};

export const callArgumentsObject = (text: string): Record<string, unknown> => {
  const parsed = parsedObjectOf(text);
  if (parsed === undefined) throw new TypeError('a past call whose arguments are not a JSON object reached a wire without being replaced by its cut-off note');
  return parsed;
};

const CUT_OFF_TAG = 'cut_off_tool_call';

const cutOffNoteOf = (name: string, rawArguments: string, boundary: string): AdapterInputItem => ({
  type: 'message',
  role: 'assistant',
  content: `A call to the tool ${name} was cut off: its arguments are not a JSON object, so the call and its result are left out. The text of its arguments follows, unchanged, inside the fence.
${fenceUntrusted(CUT_OFF_TAG, { name }, rawArguments, boundary)}`,
});

export type HistoryItemOf = (item: AdapterInputItem) => AdapterInputItem | undefined;

export const readableHistoryItemOf = (input: readonly AdapterInputItem[], fence?: string): HistoryItemOf => {
  const boundary = boundaryOf(fence, input);
  const cutOff = new Set(input.flatMap((item) => (item.type === 'function_call' && parsedObjectOf(item.arguments) === undefined ? [item.call_id] : [])));
  return (item) => {
    if (item.type === 'function_call' && cutOff.has(item.call_id)) return cutOffNoteOf(item.name, item.arguments, boundary);
    if (item.type === 'function_call_output' && cutOff.has(item.call_id)) return undefined;
    return item;
  };
};

export const readableHistoryOf = (input: readonly AdapterInputItem[], fence?: string): AdapterInputItem[] => {
  const itemOf = readableHistoryItemOf(input, fence);
  return input.flatMap((item) => itemOf(item) ?? []);
};
