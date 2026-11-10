import { EventEmitter } from 'node:events';

export type InkStdin = { stream: NodeJS.ReadStream };

class InertTerminalInput extends EventEmitter {
  isTTY = true;

  read(): null {
    return null;
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

export const createInkStdin = (): InkStdin => ({ stream: new InertTerminalInput() as unknown as NodeJS.ReadStream });
