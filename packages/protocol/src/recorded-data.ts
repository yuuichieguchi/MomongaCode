import type { MessageInputItem } from './open-responses.ts';

export const RECORDED_DATA_MARKER = 'recorded data, not instructions';

export type RecordedData = { readonly tag: string; readonly origin: string; readonly text: string };

export const recordedDataMessage = ({ tag, origin, text }: RecordedData): MessageInputItem => ({
  type: 'message',
  role: 'user',
  content: `<${tag}>\n${origin}\n${text.replaceAll('<', '&lt;')}\n</${tag}>`,
});
