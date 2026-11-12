import path from 'node:path';
import { spawn } from '@momonga/testkit/child-process';
import { describe, expect, it } from 'vitest';

const ENTRY = path.resolve(import.meta.dirname, 'exec-flush-entry.ts');
const CHILD_TIMEOUT_MS = 60_000;

const outputOf = (way: 'exec' | 'relay'): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, way], { env: { PATH: process.env['PATH'] ?? '' }, timeout: CHILD_TIMEOUT_MS });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', reject);
    child.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    child.stdin.end();
  });

describe('a process that hands over after writing a result larger than the pipe buffer', { timeout: CHILD_TIMEOUT_MS * 2 }, () => {
  it.skipIf(typeof process.execve !== 'function')('delivers the whole result before it replaces itself', async () => {
    expect((await outputOf('exec')).endsWith('end of the result\n')).toBe(true);
  });

  it('delivers the whole result before it exits with the code of the program it relayed', async () => {
    expect((await outputOf('relay')).endsWith('end of the result\n')).toBe(true);
  });
});
