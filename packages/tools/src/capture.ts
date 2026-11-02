const HEAD_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 4 * 1024 * 1024;
const CONTINUATION_BYTE = 0b1100_0000;

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & CONTINUATION_BYTE) === 0b1000_0000;

export const createCapture = () => {
  const head: Buffer[] = [];
  const tail: Buffer[] = [];
  let headSize = 0;
  let tailSize = 0;
  let omitted = 0;
  return {
    push(chunk: Buffer): void {
      let rest = chunk;
      if (headSize < HEAD_BYTES) {
        const taken = rest.subarray(0, HEAD_BYTES - headSize);
        head.push(taken);
        headSize += taken.length;
        rest = rest.subarray(taken.length);
      }
      if (rest.length === 0) return;
      tail.push(rest);
      tailSize += rest.length;
      while (tailSize > TAIL_BYTES) {
        const excess = tailSize - TAIL_BYTES;
        const first = tail[0] as Buffer;
        if (first.length <= excess) {
          tail.shift();
          omitted += first.length;
          tailSize -= first.length;
        } else {
          tail[0] = first.subarray(excess);
          omitted += excess;
          tailSize -= excess;
        }
      }
    },
    text(): string {
      let headBytes = Buffer.concat(head);
      let tailBytes = Buffer.concat(tail);
      if (omitted === 0) return Buffer.concat([headBytes, tailBytes]).toString('utf8');
      let leadIndex = headBytes.length - 1;
      while (leadIndex > 0 && isContinuation(headBytes[leadIndex])) leadIndex -= 1;
      const lead = headBytes[leadIndex] ?? 0;
      const sequenceLength = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= CONTINUATION_BYTE ? 2 : 1;
      const headEnd = leadIndex + sequenceLength > headBytes.length ? leadIndex : headBytes.length;
      let tailStart = 0;
      while (tailStart < tailBytes.length && isContinuation(tailBytes[tailStart])) tailStart += 1;
      const dropped = omitted + (headBytes.length - headEnd) + tailStart;
      headBytes = headBytes.subarray(0, headEnd);
      tailBytes = tailBytes.subarray(tailStart);
      return `${headBytes.toString('utf8')}\n[… ${dropped} bytes omitted …]\n${tailBytes.toString('utf8')}`;
    },
  };
};

const STREAM_DRAIN_MS = 1000;

export const pumpOutput = (
  streams: readonly AsyncIterable<Uint8Array>[],
  onChunk: (streamIndex: number, chunk: Buffer) => void,
): { settle(): Promise<void>; close(): Promise<void>; failure(): { error: unknown } | undefined } => {
  const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());
  let streamFailure: { error: unknown } | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= Promise.all(iterators.map((iterator) => iterator.return?.())).then(() => undefined));
  const pumps = iterators.map((iterator, index) =>
    (async () => {
      for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) onChunk(index, Buffer.from(step.value));
    })().catch((error: unknown) => {
      streamFailure ??= { error };
      close().catch((closeError: unknown) => {
        streamFailure ??= { error: closeError };
      });
    }),
  );
  return {
    settle: async () => {
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STREAM_DRAIN_MS);
      });
      try {
        await Promise.race([Promise.all(pumps).then(() => undefined), expired]);
      } finally {
        clearTimeout(timer);
      }
    },
    close,
    failure: () => streamFailure,
  };
};
