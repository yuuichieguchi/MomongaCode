import { parseBoundedJson } from '@momonga/foundation';
import type { ContentPart, InputItem } from '@momonga/protocol';
import type { DeepReadonly } from './types.ts';
import { outputTextOf } from './tool-output.ts';

const stringLeavesOf = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeavesOf);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringLeavesOf);
  return [];
};

const textOfPart = (part: DeepReadonly<ContentPart>): string => {
  switch (part.type) {
    case 'input_text':
    case 'output_text':
    case 'summary_text':
    case 'reasoning_text':
      return part.text;
    case 'refusal':
      return part.refusal;
    case 'input_image':
    case 'input_file':
      return '';
  }
};

export const textOfContent = (content: string | readonly DeepReadonly<ContentPart>[]): string =>
  typeof content === 'string' ? content : content.map(textOfPart).join('\n');

export const textOfItem = (item: DeepReadonly<InputItem>): string => {
  switch (item.type) {
    case 'message':
      return textOfContent(item.content);
    case 'function_call': {
      const parsed = parseBoundedJson(item.arguments);
      return [`${item.name} ${item.arguments}`, ...stringLeavesOf(parsed.kind === 'value' ? parsed.value : parsed.text)].join('\n');
    }
    case 'function_call_output':
      return outputTextOf(item.output as Parameters<typeof outputTextOf>[0]);
    case 'reasoning':
      return textOfContent([...item.summary, ...(item.content ?? [])]);
    case 'compaction':
      return '';
  }
};
