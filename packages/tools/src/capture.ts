import type { ToolTimers } from './ports.ts';

const HEAD_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 4 * 1024 * 1024;
const CONTINUATION_BYTE = 0b1100_0000;

const isContinuation = (byte: number | undefined): boolean => byte !== undefined && (byte & CONTINUATION_BYTE) === 0b1000_0000;

export const createCapture = (headLimit: number = HEAD_BYTES, tailLimit: number = TAIL_BYTES) => {
  const head: Buffer[] = [];
  const tail: Buffer[] = [];
  let headSize = 0;
  let tailSize = 0;
  let omitted = 0;
  return {
    push(chunk: Buffer): void {
      let rest = chunk;
      if (headSize < headLimit) {
        const taken = rest.subarray(0, headLimit - headSize);
        head.push(taken);
        headSize += taken.length;
        rest = rest.subarray(taken.length);
      }
      if (rest.length === 0) return;
      tail.push(rest);
      tailSize += rest.length;
      while (tailSize > tailLimit) {
        const excess = tailSize - tailLimit;
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

export const CAPTURE_MAX_BYTES = HEAD_BYTES + TAIL_BYTES;

export const DRAIN_RESIDUE_MAX_BYTES = CAPTURE_MAX_BYTES;

export type DrainEnd = { kind: 'idle'; idleMs: number } | { kind: 'bytes'; maxBytes: number };

export type Drained = { complete: true } | { complete: false; note: string };

export const drainIncompleteNote = (end: DrainEnd): string =>
  end.kind === 'idle'
    ? `Stopped reading output after ${end.idleMs} ms without data; output may be incomplete.`
    : `Stopped reading output after ${end.maxBytes} bytes that came after the command ended; output may be incomplete.`;

export type PumpedOutput = {
  drainAfterExit(idleMs: number): Promise<Drained>;
  ended(): Promise<void>;
  close(): Promise<void>;
  failure(): { error: unknown } | undefined;
};

export const pumpOutput = (streams: readonly AsyncIterable<Uint8Array>[], onChunk: (streamIndex: number, chunk: Buffer) => void, timers: ToolTimers): PumpedOutput => {
  const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());
  let streamFailure: { error: unknown } | undefined;
  let closing: Promise<void> | undefined;
  let draining: ((bytes: number) => void) | undefined;
  const close = (): Promise<void> => (closing ??= Promise.all(iterators.map((iterator) => iterator.return?.())).then(() => undefined));
  const pumps = iterators.map((iterator, index) =>
    (async () => {
      for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) {
        const chunk = Buffer.from(step.value);
        onChunk(index, chunk);
        draining?.(chunk.length);
      }
    })().catch((error: unknown) => {
      streamFailure ??= { error };
      close().catch((closeError: unknown) => {
        streamFailure ??= { error: closeError };
      });
    }),
  );
  const allEnded = Promise.all(pumps).then(() => undefined);
  return {
    drainAfterExit: (idleMs) =>
      new Promise<Drained>((resolve) => {
        let settled = false;
        let received = 0;
        let idle: unknown;
        const finish = (drained: Drained): void => {
          if (settled) return;
          settled = true;
          timers.clearTimeout(idle);
          draining = undefined;
          resolve(drained);
        };
        const arm = (): void => {
          timers.clearTimeout(idle);
          idle = timers.setTimeout(() => finish({ complete: false, note: drainIncompleteNote({ kind: 'idle', idleMs }) }), idleMs);
        };
        draining = (bytes) => {
          received += bytes;
          if (received > DRAIN_RESIDUE_MAX_BYTES) finish({ complete: false, note: drainIncompleteNote({ kind: 'bytes', maxBytes: DRAIN_RESIDUE_MAX_BYTES }) });
          else arm();
        };
        arm();
        void allEnded.then(() => finish({ complete: true }));
      }),
    ended: () => allEnded,
    close,
    failure: () => streamFailure,
  };
};
