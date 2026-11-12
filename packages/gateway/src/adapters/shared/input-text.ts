import type { AdapterInputItem, ContentPart } from '@momonga/protocol';
import { UnsupportedInputError } from './failures.ts';

const PART_SEPARATOR = '\n';

const textOfPart = (part: ContentPart): string => {
  switch (part.type) {
    case 'input_text':
    case 'output_text':
    case 'summary_text':
    case 'reasoning_text':
      return part.text;
    case 'refusal':
      return part.refusal;
    case 'input_image':
      throw new UnsupportedInputError('unsupported_input', 'an input_image part cannot appear where only text is carried', 'input');
    case 'input_file':
      throw new UnsupportedInputError('unsupported_input', 'the upstream adapter does not support input_file content', 'input');
  }
};

export const textOfContent = (content: string | readonly ContentPart[]): string =>
  typeof content === 'string' ? content : content.map(textOfPart).join(PART_SEPARATOR);

export const fenceOf = (fence: string | undefined): string => {
  if (fence === undefined) throw new Error('a request that fences untrusted text reached the adapter without its fence boundary');
  return fence;
};

export type ReasoningInput = Extract<AdapterInputItem, { type: 'reasoning' }>;

export const reasoningTextOf = (item: ReasoningInput): string => {
  const content = item.content ?? [];
  return textOfContent(content.length > 0 ? content : item.summary);
};
