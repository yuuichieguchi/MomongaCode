import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { acpInputOf } from '../src/node-ports.ts';

describe('the standard input of an ACP surface handed to a new process', () => {
  it('stops reading the input and removes its listeners before the new process starts', async () => {
    const stdin = new PassThrough();
    const input = acpInputOf(stdin);

    input.release();
    stdin.write(Buffer.from('{"jsonrpc":"2.0"}\n'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stdin.isPaused()).toBe(true);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(input.take()).toBeUndefined();
  });
});
