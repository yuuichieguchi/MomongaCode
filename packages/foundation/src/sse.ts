import { createParser } from 'eventsource-parser';

export const SSE_RECONNECT_BASE_MS = 200;
export const SSE_RECONNECT_MAX_MS = 5000;
export const SSE_EVENT_MAX_BYTES = 4 * 1024 * 1024;

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

export class SseEventTooLargeError extends Error {
  readonly maxEventBytes: number;

  constructor(maxEventBytes: number) {
    super(`a server-sent event exceeds ${maxEventBytes} bytes`);
    this.name = 'SseEventTooLargeError';
    this.maxEventBytes = maxEventBytes;
  }
}

export type DecodeSseOptions = { readonly maxEventBytes: number };

export interface SseEvent {
  id?: string;
  event?: string;
  retry?: number;
  data: string;
}

export const encodeSse = (event: SseEvent): string => {
  const lines: string[] = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  if (event.retry !== undefined) lines.push(`retry: ${event.retry}`);
  for (const line of event.data.split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
};

async function* boundedSseBytes(source: AsyncIterable<string | Uint8Array>, maxEventBytes: number): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  let eventBytes = 0;
  let lineEmpty = true;
  let previousWasCarriageReturn = false;
  for await (const piece of source) {
    const chunk = typeof piece === 'string' ? encoder.encode(piece) : piece;
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
      if (eventBytes > maxEventBytes) throw new SseEventTooLargeError(maxEventBytes);
    }
    yield chunk;
  }
}

export async function* decodeSse(source: AsyncIterable<string | Uint8Array>, options: DecodeSseOptions): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const ready: SseEvent[] = [];
  let retry: number | undefined;
  const parser = createParser({
    onRetry: (value) => {
      retry = value;
    },
    onEvent: (message) => {
      ready.push({
        ...(message.id === undefined ? {} : { id: message.id }),
        ...(message.event === undefined ? {} : { event: message.event }),
        ...(retry === undefined ? {} : { retry }),
        data: message.data,
      });
      retry = undefined;
    },
  });

  for await (const chunk of boundedSseBytes(source, options.maxEventBytes)) {
    parser.feed(decoder.decode(chunk, { stream: true }));
    yield* ready.splice(0);
  }
  parser.feed(decoder.decode());
  yield* ready.splice(0);
}
