import { describe, expect, it } from 'vitest';
import { SSE_EVENT_MAX_BYTES, decodeSse, encodeSse } from '@momonga/foundation';

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
};

async function* fromChunks<T>(chunks: readonly T[]): AsyncIterable<T> {
  for (const chunk of chunks) yield chunk;
}

describe('encodeSse', () => {
  it('encodes data only', () => {
    expect(encodeSse({ data: 'hello' })).toBe('data: hello\n\n');
  });

  it('encodes id, event and multi-line data in that order', () => {
    expect(encodeSse({ id: '7', event: 'response.created', data: 'line one\nline two' })).toBe(
      'id: 7\nevent: response.created\ndata: line one\ndata: line two\n\n',
    );
  });

  it('encodes retry before data', () => {
    expect(encodeSse({ retry: 250, data: 'x' })).toBe('retry: 250\ndata: x\n\n');
  });

  it('encodes empty data as a single data line', () => {
    expect(encodeSse({ data: '' })).toBe('data: \n\n');
  });
});

describe('decodeSse', () => {
  it('decodes a single string chunk with several events', async () => {
    const text = 'id: 1\nevent: a\ndata: x\n\ndata: y\ndata: z\n\n';
    expect(await collect(decodeSse(fromChunks([text]), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual([
      { id: '1', event: 'a', data: 'x' },
      { data: 'y\nz' },
    ]);
  });

  it('ignores comment lines', async () => {
    expect(await collect(decodeSse(fromChunks([': keep-alive\n\ndata: real\n\n']), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual([{ data: 'real' }]);
  });

  it('accepts a data field without a space after the colon', async () => {
    expect(await collect(decodeSse(fromChunks(['data:compact\n\n']), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual([{ data: 'compact' }]);
  });

  it('does not emit an unterminated trailing event', async () => {
    expect(await collect(decodeSse(fromChunks(['data: done\n\ndata: partial']), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual([{ data: 'done' }]);
  });
});

describe('decodeSse spec conformance', () => {
  it('treats a lone carriage return as a line terminator', async () => {
    expect(await collect(decodeSse(fromChunks(['data: a\r\rdata: b\r\r']), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('treats a carriage return and line feed split across chunks as one terminator', async () => {
    expect(await collect(decodeSse(fromChunks(['data: a\r', '\n\r', '\ndata: b\r\n\r\n']), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual([
      { data: 'a' },
      { data: 'b' },
    ]);
  });

  it('ignores an id field that contains NUL', async () => {
    expect(await collect(decodeSse(fromChunks(['id: a\u0000b\ndata: x\n\n']), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual([{ data: 'x' }]);
  });

  it('exposes the retry field on the next event', async () => {
    expect(await collect(decodeSse(fromChunks(['retry: 1500\ndata: x\n\ndata: y\n\n']), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual([
      { retry: 1500, data: 'x' },
      { data: 'y' },
    ]);
  });

  it('ignores a retry field that is not digits', async () => {
    expect(await collect(decodeSse(fromChunks(['retry: soon\ndata: x\n\n']), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual([{ data: 'x' }]);
  });

  it('ends cleanly when the final chunk stops inside a multi-byte sequence', async () => {
    const bytes = new TextEncoder().encode('data: first\n\ndata: こ');
    expect(await collect(decodeSse(fromChunks([bytes.slice(0, bytes.length - 1)]), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual([{ data: 'first' }]);
  });

  it('strips a leading byte order mark', async () => {
    const bytes = new TextEncoder().encode('\uFEFFdata: x\n\n');
    expect(await collect(decodeSse(fromChunks([bytes]), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual([{ data: 'x' }]);
  });
});

describe('encodeSse/decodeSse round trip', () => {
  const events = [
    { id: '1', event: 'response.output_text.delta', data: '{"delta":"こんにちは"}' },
    { data: 'first line\nsecond line\nthird 🐿 line' },
    { event: 'done', data: '[DONE]' },
  ];
  const encodeAll = (): string => events.map((event) => encodeSse(event)).join('');
  const encodeBytes = (): Uint8Array => new TextEncoder().encode(encodeAll());

  it('round-trips string input', async () => {
    expect(await collect(decodeSse(fromChunks([encodeAll()]), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual(events);
  });

  it('round-trips byte input split at every possible boundary, including inside multi-byte characters', async () => {
    const bytes = encodeBytes();
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
      expect(await collect(decodeSse(fromChunks(chunks), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual(events);
    }
  });

  it('round-trips byte input delivered one byte at a time', async () => {
    const chunks = Array.from(encodeBytes(), (byte) => Uint8Array.of(byte));
    expect(await collect(decodeSse(fromChunks(chunks), { maxEventBytes: SSE_EVENT_MAX_BYTES }))).toEqual(events);
  });
});
