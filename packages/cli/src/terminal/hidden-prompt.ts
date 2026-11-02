import { StringDecoder } from 'node:string_decoder';
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
const ESCAPE = '\u001b';
const CARRIAGE_RETURN = '\r';
const LINE_FEED = '\n';
const CONTROL_SEQUENCE_INTRODUCER = '[';
const SINGLE_SHIFT_THREE = 'O';
const CONTROL_SEQUENCE_FINAL_FIRST = '@';
const CONTROL_SEQUENCE_FINAL_LAST = '~';

type EscapeState = 'none' | 'introduced' | 'control_sequence' | 'single_shift_three';

type LineProgress = { kind: 'open'; value: string } | { kind: 'line'; value: string } | { kind: 'interrupted' };

class KeyStream {
  readonly #decoder = new StringDecoder('utf8');
  #pending = '';
  #escape: EscapeState = 'none';
  #lineFeedFollowsCarriageReturn = false;

  push(chunk: Buffer | string): void {
    this.#pending += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
  }

  take(initial: string): LineProgress {
    const pending = this.#pending;
    let value = initial;
    let consumed = 0;
    for (const character of pending) {
      consumed += character.length;
      const swallowLineFeed = this.#lineFeedFollowsCarriageReturn;
      this.#lineFeedFollowsCarriageReturn = false;
      if (this.#discardsEscape(character) || (swallowLineFeed && character === LINE_FEED)) continue;
      if (character === CARRIAGE_RETURN || character === LINE_FEED) {
        this.#lineFeedFollowsCarriageReturn = character === CARRIAGE_RETURN;
        this.#pending = pending.slice(consumed);
        return { kind: 'line', value };
      }
      if (character === END_OF_TEXT || (character === END_OF_TRANSMISSION && value === '')) {
        this.#pending = pending.slice(consumed);
        return { kind: 'interrupted' };
      }
      if (character === BACKSPACE || character === BACKSPACE_CONTROL) value = value.slice(0, -1);
      else if (character >= ' ') value += character;
    }
    this.#pending = '';
    return { kind: 'open', value };
  }

  #discardsEscape(character: string): boolean {
    switch (this.#escape) {
      case 'none':
        if (character !== ESCAPE) return false;
        this.#escape = 'introduced';
        return true;
      case 'introduced':
        if (character === ESCAPE) return true;
        if (character === CONTROL_SEQUENCE_INTRODUCER) this.#escape = 'control_sequence';
        else if (character === SINGLE_SHIFT_THREE) this.#escape = 'single_shift_three';
        else {
          this.#escape = 'none';
          return false;
        }
        return true;
      case 'control_sequence':
        if (character < ' ') {
          this.#escape = 'none';
          return false;
        }
        if (character >= CONTROL_SEQUENCE_FINAL_FIRST && character <= CONTROL_SEQUENCE_FINAL_LAST) this.#escape = 'none';
        return true;
      case 'single_shift_three':
        this.#escape = 'none';
        return character >= ' ';
    }
  }
}

const readLine = (terminal: PromptTerminal, keys: KeyStream, label: string, signal: AbortSignal): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    signal.throwIfAborted();
    const { stdin, stdout } = terminal;
    let value = '';
    let finished = false;
    const finish = (settle: () => void): void => {
      finished = true;
      stdin.off('data', onData);
      signal.removeEventListener('abort', onAbort);
      stdout.write('\n');
      settle();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    const advance = (): void => {
      if (finished) return;
      const progress = keys.take(value);
      if (progress.kind === 'open') value = progress.value;
      else if (progress.kind === 'line') finish(() => resolve(progress.value));
      else finish(() => reject(new PromptInterrupted()));
    };
    const onData = (chunk: Buffer | string): void => {
      keys.push(chunk);
      advance();
    };    stdout.write(label);
    signal.addEventListener('abort', onAbort, { once: true });
    stdin.on('data', onData);
    advance();
  });

export const withHiddenInput = async <T>(terminal: PromptTerminal, signal: AbortSignal, use: (read: HiddenLineReader) => Promise<T>): Promise<T> => {
  signal.throwIfAborted();
  const { stdin } = terminal;
  const keys = new KeyStream();
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await use((label) => readLine(terminal, keys, label, signal));
  } finally {
    stdin.pause();
    stdin.setRawMode(false);
  }
};
