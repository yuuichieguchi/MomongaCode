import { UpstreamProtocolError } from './failures.ts';

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

export async function* boundedSseBytes(source: AsyncIterable<Uint8Array>, maxEventBytes: number): AsyncGenerator<Uint8Array> {
  let eventBytes = 0;
  let lineEmpty = true;
  let previousWasCarriageReturn = false;
  for await (const chunk of source) {
    for (const byte of chunk) {
      const lineBreak = byte === CARRIAGE_RETURN || (byte === LINE_FEED && !previousWasCarriageReturn);
      previousWasCarriageReturn = byte === CARRIAGE_RETURN;
      if (byte === LINE_FEED && !lineBreak) continue;
      if (!lineBreak) {
        lineEmpty = false;
        eventBytes += 1;
      } else if (lineEmpty) {
        eventBytes = 0;
      } else {
        lineEmpty = true;
        eventBytes += 1;
      }
      if (eventBytes > maxEventBytes) {
        throw new UpstreamProtocolError(`an upstream server-sent event exceeds ${maxEventBytes} bytes`);
      }
    }
    yield chunk;
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
