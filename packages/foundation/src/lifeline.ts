import fs from 'node:fs';
import net from 'node:net';
import { EntryUsageError } from './entry-flags.ts';
import { STOP_MESSAGE_MAX_BYTES } from './process-contract.ts';

const assertUsableLifelineFd = (fd: number): void => {
  let stat: fs.Stats;
  try {
    stat = fs.fstatSync(fd);
  } catch (error) {
    throw new EntryUsageError(`lifeline fd ${fd} is not usable: ${(error as Error).message}`);
  }
  if (!stat.isSocket() && !stat.isFIFO()) throw new EntryUsageError(`lifeline fd ${fd} is not usable: not a socket or pipe`);
};

export type LifelineHandlers = { onEnd(): void; onLine(line: string): void; onOverlongLine(): void };

export type LifelineWatch = { dispose(): void; drain(): Promise<void> };

const LINE_FEED = 0x0a;

const createLineReader = (onLine: (line: string) => void, onOverlongLine: () => void): ((chunk: Buffer) => void) => {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let overlong = false;
  const append = (part: Buffer): void => {
    if (overlong) return;
    if (pendingBytes + part.length > STOP_MESSAGE_MAX_BYTES) {
      overlong = true;
      pending = [];
      pendingBytes = 0;
      return;
    }
    pending.push(part);
    pendingBytes += part.length;
  };
  return (chunk) => {
    let start = 0;
    for (let index = chunk.indexOf(LINE_FEED); index !== -1; index = chunk.indexOf(LINE_FEED, start)) {
      append(chunk.subarray(start, index));
      const wasOverlong = overlong;
      const line = Buffer.concat(pending).toString('utf8');
      pending = [];
      pendingBytes = 0;
      overlong = false;
      start = index + 1;
      if (wasOverlong) onOverlongLine();
      else onLine(line);
    }
    append(chunk.subarray(start));
  };
};

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const watchLifeline = (fd: number, handlers: LifelineHandlers): LifelineWatch => {
  assertUsableLifelineFd(fd);
  const socket = new net.Socket({ fd, readable: true, writable: false });
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    handlers.onEnd();
  };
  const read = createLineReader(
    (line) => {
      if (!ended) handlers.onLine(line);
    },
    () => {
      if (!ended) handlers.onOverlongLine();
    },
  );
  socket.on('data', read);
  socket.on('end', end);
  socket.on('close', end);
  socket.on('error', end);
  return {
    dispose: () => {
      ended = true;
      socket.destroy();
    },
    drain: async () => {
      await nextTurn();
      await nextTurn();
    },
  };
};
