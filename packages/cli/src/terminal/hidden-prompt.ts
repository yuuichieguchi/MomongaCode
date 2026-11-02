import type { Terminal } from '../ports.ts';

export class PromptInterrupted extends Error {
  constructor() {
    super('the prompt was interrupted');
    this.name = 'PromptInterrupted';
  }
}

export type PromptTerminal = {
  stdin: Pick<Terminal['stdin'], 'setRawMode' | 'resume' | 'pause' | 'on' | 'off'>;
  stdout: Pick<Terminal['stdout'], 'write'>;
};

export type HiddenLineReader = (label: string) => Promise<string>;

const END_OF_TEXT = '\u0003';
const END_OF_TRANSMISSION = '\u0004';
const BACKSPACE = '\u007f';
const BACKSPACE_CONTROL = '\b';

const readLine = (terminal: PromptTerminal, label: string, signal: AbortSignal): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    signal.throwIfAborted();
    const { stdin, stdout } = terminal;
    let value = '';
    const finish = (settle: () => void): void => {
      stdin.off('data', onData);
      signal.removeEventListener('abort', onAbort);
      stdout.write('\n');
      settle();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    const onData = (chunk: Buffer | string): void => {
      for (const character of typeof chunk === 'string' ? chunk : chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          finish(() => resolve(value));
          return;
        }
        if (character === END_OF_TEXT || (character === END_OF_TRANSMISSION && value === '')) {
          finish(() => reject(new PromptInterrupted()));
          return;
        }
        if (character === BACKSPACE || character === BACKSPACE_CONTROL) value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    stdout.write(label);
    stdin.on('data', onData);
    signal.addEventListener('abort', onAbort, { once: true });
  });

export const withHiddenInput = async <T>(terminal: PromptTerminal, signal: AbortSignal, use: (read: HiddenLineReader) => Promise<T>): Promise<T> => {
  signal.throwIfAborted();
  const { stdin } = terminal;
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await use((label) => readLine(terminal, label, signal));
  } finally {
    stdin.pause();
    stdin.setRawMode(false);
  }
};
