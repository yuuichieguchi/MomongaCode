import type { JsonReplyPath, ResponseResource } from './open-responses.ts';

const isRecord =(value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const assistantTextOf = (output: readonly unknown[]): string =>
  output
    .flatMap((item) => {
      if (!isRecord(item) || item['type'] !== 'message' || item['role'] !== 'assistant' || !Array.isArray(item['content'])) return [];
      const parts: unknown[] = item['content'];
      return [parts.flatMap((part) => (isRecord(part) && part['type'] === 'output_text' && typeof part['text'] === 'string' ? [part['text']] : [])).join('')];
    })
    .join('');

export const jsonReplyOf = (response: Pick<ResponseResource, 'output' | 'status' | 'incomplete_details' | 'momonga'>): { text: string; incomplete: string | undefined; path: JsonReplyPath | undefined } => ({
  text: assistantTextOf(response.output),
  incomplete: response.status === 'incomplete' ? (response.incomplete_details?.reason ?? 'no reason given') : undefined,
  path: response.momonga?.jsonReply,
});
