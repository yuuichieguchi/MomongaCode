import { createParser } from 'eventsource-parser';

export const SSE_RECONNECT_BASE_MS = 200;
export const SSE_RECONNECT_MAX_MS = 5000;

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

export async function* decodeSse(source: AsyncIterable<string | Uint8Array>): AsyncGenerator<SseEvent> {
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

  for await (const chunk of source) {
    parser.feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    yield* ready.splice(0);
  }
  parser.feed(decoder.decode());
  yield* ready.splice(0);
}
