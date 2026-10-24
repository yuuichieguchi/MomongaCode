import { LINE_MAX_BYTES } from './constants.ts';

export type LineSplitter = {
  push(chunk: Buffer): void;
  end(): void;
};

const NEWLINE = 0x0a;
const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BITS = 0x80;

const isContinuationByte = (byte: number | undefined): boolean => byte !== undefined && (byte & CONTINUATION_MASK) === CONTINUATION_BITS;

const characterBoundaryAtOrBefore = (bytes: Buffer, limit: number): number => {
  let end = limit;
  while (end > 0 && isContinuationByte(bytes[end])) end -= 1;
  if (end > 0) return end;
  end = 1;
  while (end < bytes.length && isContinuationByte(bytes[end])) end += 1;
  return end;
};

export const createLineSplitter = (onLine: (line: string) => void, maxBytes: number = LINE_MAX_BYTES): LineSplitter => {
  let pending: Buffer = Buffer.alloc(0);

  const emit = (bytes: Buffer): void => {
    onLine(bytes.toString('utf8'));
  };

  const drain = (): void => {
    for (;;) {
      const newline = pending.indexOf(NEWLINE);
      if (newline !== -1 && newline <= maxBytes) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        emit(line);
        continue;
      }
      if (pending.length <= maxBytes) return;
      const cut = characterBoundaryAtOrBefore(pending, maxBytes);
      const part = pending.subarray(0, cut);
      pending = pending.subarray(cut);
      emit(part);
    }
  };

  return {
    push: (chunk) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      drain();
    },
    end: () => {
      if (pending.length === 0) return;
      const rest = pending;
      pending = Buffer.alloc(0);
      emit(rest);
    },
  };
};
