import { writeSync } from 'node:fs';
import type { ProcessPort, TerminalOutputPort } from './layer.ts';

const descriptorOf = (stdout: NodeJS.WriteStream): number => {
  if ('fd' in stdout && typeof stdout.fd === 'number') return stdout.fd;
  throw new Error('the terminal output has no file descriptor to write to');
};

export const hostTerminalOutput = (stdout: NodeJS.WriteStream, descriptor = descriptorOf(stdout)): TerminalOutputPort => ({
  writeSync: (text) => {
    writeSync(descriptor, text);
  },
  size: () => ({ columns: stdout.columns, rows: stdout.rows }),
  onResize: (listener) => {
    stdout.on('resize', listener);
    return () => {
      stdout.off('resize', listener);
    };
  },
});

export const hostProcess: ProcessPort = {
  on: (event, listener) => {
    process.on(event, listener);
  },
  off: (event, listener) => {
    process.off(event, listener);
  },
  kill: (signal) => {
    process.kill(process.pid, signal);
  },
};
