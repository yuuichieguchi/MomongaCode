import { SSE_EVENT_MAX_BYTES, SseEventTooLargeError, decodeSse } from '@momonga/foundation';
import type { SseEvent } from '@momonga/foundation';
import { UpstreamProtocolError } from './failures.ts';

export async function* upstreamSseEvents(source: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  try {
    yield* decodeSse(source, { maxEventBytes: SSE_EVENT_MAX_BYTES });
  } catch (error) {
    if (error instanceof SseEventTooLargeError) throw new UpstreamProtocolError(`an upstream server-sent event exceeds ${error.maxEventBytes} bytes`);
    throw error;
  }
}

export type LimitedText = { text: string; truncated: boolean };

const isTokenCharacter = (character: string | undefined): boolean => character !== undefined && /[A-Za-z0-9_+/=.\\%-]/.test(character);

const withoutTrailingToken = (text: string): string => {
  let end = text.length;
  while (end > 0 && isTokenCharacter(text[end - 1])) end -= 1;
  return text.slice(0, end);
};

export const readTextLimited = async (source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<LimitedText> => {
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  let truncated = false;
  for await (const chunk of source) {
    if (chunk.length === 0) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    total += slice.length;
    text += decoder.decode(slice, { stream: true });
    if (chunk.length > remaining) {
      truncated = true;
      break;
    }
  }
  text += decoder.decode();
  return { text: truncated ? withoutTrailingToken(text) : text, truncated };
};
