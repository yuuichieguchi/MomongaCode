import fs from 'node:fs';
import net from 'node:net';
import { EntryUsageError } from './entry-flags.ts';

const assertUsableLifelineFd = (fd: number): void => {
  let stat: fs.Stats;
  try {
    stat = fs.fstatSync(fd);
  } catch (error) {
    throw new EntryUsageError(`lifeline fd ${fd} is not usable: ${(error as Error).message}`);
  }
  if (!stat.isSocket() && !stat.isFIFO()) throw new EntryUsageError(`lifeline fd ${fd} is not usable: not a socket or pipe`);
};

export const watchLifeline = (fd: number, onEnd: () => void): (() => void) => {
  assertUsableLifelineFd(fd);
  const socket = new net.Socket({ fd, readable: true, writable: false });
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  socket.on('data', () => undefined);
  socket.on('end', end);
  socket.on('close', end);
  socket.on('error', end);
  return () => {
    ended = true;
    socket.destroy();
  };
};
