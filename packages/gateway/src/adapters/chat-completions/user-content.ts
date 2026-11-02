import type { ContentPart } from '@momonga/protocol';
import { UnsupportedInputError } from '../shared/failures.ts';
import { hasImagePart, imageUrlOf } from '../shared/image-part.ts';
import { textOfContent } from '../shared/input-text.ts';

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

const partOf = (part: ContentPart): ChatContentPart => {
  switch (part.type) {
    case 'input_text':
    case 'output_text':
    case 'summary_text':
      return { type: 'text', text: part.text };
    case 'refusal':
      return { type: 'text', text: part.refusal };
    case 'input_image':
      return { type: 'image_url', image_url: { url: imageUrlOf(part), ...(part.detail === undefined ? {} : { detail: part.detail }) } };
    case 'input_file':
      throw new UnsupportedInputError('unsupported_input', 'the upstream adapter does not support input_file content', 'input');
  }
};

export const userContentOf = (content: string | readonly ContentPart[]): string | ChatContentPart[] =>
  hasImagePart(content) ? (content as readonly ContentPart[]).map(partOf) : textOfContent(content);
