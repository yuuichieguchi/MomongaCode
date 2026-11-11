import { describe, expect, it } from 'vitest';
import { SSE_EVENT_MAX_BYTES, SseEventTooLargeError, decodeSse } from '@momonga/foundation';
import type { SseEvent } from '@momonga/foundation';

const BOUND = 64;

async function* chunksOf(chunks: readonly string[]): AsyncGenerator<string> {
  yield* chunks;
}

const collect = async (source: AsyncIterable<string | Uint8Array>, maxEventBytes: number): Promise<SseEvent[]> => {
  const events: SseEvent[] = [];
  for await (const event of decodeSse(source, { maxEventBytes })) events.push(event);
  return events;
};

describe('the SSE decoder bounds one event', () => {
  it('is four mebibytes, the largest single event a model stream sends', () => {
    expect(SSE_EVENT_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  it('refuses a line with no end once it passes the bound, without reading the rest of the stream', async () => {
    let pulled = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        pulled += 1;
        yield new TextEncoder().encode(`data: ${'x'.repeat(BOUND)}`);
      }
    }
    const failure = await collect(endless(), BOUND).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SseEventTooLargeError);
    expect((failure as SseEventTooLargeError).maxEventBytes).toBe(BOUND);
    expect(pulled).toBe(1);
  });

  it('counts the bytes of text chunks, not their characters', async () => {
    const wide = 'é'.repeat(BOUND / 2);
    const failure = await collect(chunksOf([`data: ${wide}\n\n`]), BOUND).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SseEventTooLargeError);
  });

  it('passes events under the bound and starts the count again at each blank line', async () => {
    const chunk = `data: ${'y'.repeat(BOUND / 2)}\n\n`;
    const events = await collect(chunksOf([chunk, chunk, chunk]), BOUND);
    expect(events.map((event) => event.data)).toEqual(['y'.repeat(BOUND / 2), 'y'.repeat(BOUND / 2), 'y'.repeat(BOUND / 2)]);
  });
});
