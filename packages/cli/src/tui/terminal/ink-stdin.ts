import { EventEmitter } from 'node:events';

export type InkStdin = { stream: NodeJS.ReadStream; push(text: string): void };

class InertTerminalInput extends EventEmitter {
  isTTY = true;
  private queued: string[] = [];

  constructor() {
    super();
    this.on('newListener', (event) => {
      if (event === 'readable' && this.queued.length > 0) queueMicrotask(() => this.emit('readable'));
    });
  }

  push(text: string): void {
    this.queued.push(text);
    this.emit('readable');
  }

  read(): string | null {
    if (this.queued.length === 0) return null;
    const text = this.queued.join('');
    this.queued = [];
    return text;
  }

  setRawMode(): this {
    return this;
  }

  setEncoding(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

export const createInkStdin = (): InkStdin => {
  const input = new InertTerminalInput();
  return {
    stream: input as unknown as NodeJS.ReadStream,
    push: (text) => {
      if (text !== '') input.push(text);
    },
  };
};
