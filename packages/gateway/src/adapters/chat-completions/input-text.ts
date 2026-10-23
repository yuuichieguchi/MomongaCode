import type { ContentPart } from '@momonga/protocol';
import { UnsupportedInputError } from './failures.ts';

const PART_SEPARATOR = '\n';

const textOfPart = (part: ContentPart): string => {
  switch (part.type) {
    case 'input_text':
    case 'output_text':
    case 'summary_text':
      return part.text;
    case 'refusal':
      return part.refusal;
    case 'input_image':
    case 'input_file':
      throw new UnsupportedInputError(
        'unsupported_input',
        `the chat-completions adapter does not support ${part.type} content`,
        'input',
      );
  }
};

export const textOfContent = (content: string | readonly ContentPart[]): string =>
  typeof content === 'string' ? content : content.map(textOfPart).join(PART_SEPARATOR);

export const neutralizeMarkup = (text: string): string => text.replaceAll('<', '&lt;');

export const escapeAttribute = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\r\n]/g, ' ');
