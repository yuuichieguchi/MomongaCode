const CONTINUATION_MASK = 0b1100_0000;
const CONTINUATION_BITS = 0b1000_0000;

export type JobOutputWindow = { start: number; total: number; bytes: Buffer };

export type JobOutput = { push(chunk: Buffer): void; window(): JobOutputWindow };

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & CONTINUATION_MASK) === CONTINUATION_BITS;

export const createJobOutput = (maxBytes: number): JobOutput => {
  const chunks: Buffer[] = [];
  let retained = 0;
  let start = 0;
  let total = 0;

  const dropOldest = (): void => {
    while (retained > maxBytes) {
      const first = chunks[0] as Buffer;
      const excess = retained - maxBytes;
      if (first.length <= excess) {
        chunks.shift();
        retained -= first.length;
        start += first.length;
      } else {
        chunks[0] = first.subarray(excess);
        retained -= excess;
        start += excess;
      }
    }
    for (let first = chunks[0]; first !== undefined && isContinuation(first[0]); first = chunks[0]) {
      chunks[0] = first.subarray(1);
      retained -= 1;
      start += 1;
      if (chunks[0]?.length === 0) chunks.shift();
    }
  };

  return {
    push: (chunk) => {
      chunks.push(chunk);
      retained += chunk.length;
      total += chunk.length;
      dropOldest();
    },
    window: () => ({ start, total, bytes: Buffer.concat(chunks) }),
  };
};
