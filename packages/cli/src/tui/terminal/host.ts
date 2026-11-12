import { writeSync } from 'node:fs';
import { signalsOf } from '@momonga/foundation';
import type { ProcessPort, TerminalOutputPort } from './layer.ts';

export class TerminalWriteError extends Error {
  constructor(reason: string) {
    super(`the terminal took no more output: ${reason}`);
    this.name = 'TerminalWriteError';
  }
}

export type DescriptorWrite = (descriptor: number, buffer: Buffer, offset: number) => number;

export type HostOutput = { readonly kind: 'output'; readonly port: TerminalOutputPort } | { readonly kind: 'no-descriptor' };

export const NO_DESCRIPTOR_TEXT = 'the terminal output has no file descriptor to write to';

const writeWhole = (write: DescriptorWrite, descriptor: number, text: string): void => {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += write(descriptor, buffer, offset);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EAGAIN') throw new TerminalWriteError(error.message);
      throw error;
    }
  }
};

export const terminalOutputOf = (stdout: NodeJS.WriteStream, write: DescriptorWrite): HostOutput => {
  const descriptor: unknown = 'fd' in stdout ? stdout.fd : undefined;
  if (typeof descriptor !== 'number') return { kind: 'no-descriptor' };
  return {
    kind: 'output',
    port: {
      writeSync: (text) => writeWhole(write, descriptor, text),
      size: () => ({ columns: stdout.columns, rows: stdout.rows }),
      onResize: (listener) => {
        stdout.on('resize', listener);
        return () => {
          stdout.off('resize', listener);
        };
      },
    },
  };
};

export const hostTerminalOutput = (stdout: NodeJS.WriteStream): HostOutput => terminalOutputOf(stdout, (descriptor, buffer, offset) => writeSync(descriptor, buffer, offset));

export const hostProcessOn = (platform: NodeJS.Platform): ProcessPort => ({
  on: (event, listener) => {
    process.on(event, listener);
  },
  off: (event, listener) => {
    process.off(event, listener);
  },
  kill: (signal) => {
    process.kill(process.pid, signal);
  },
  deliverable: (signal) => signalsOf(platform).includes(signal),
});
