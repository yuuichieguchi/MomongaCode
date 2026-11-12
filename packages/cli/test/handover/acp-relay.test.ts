import { fork } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir } from '@momonga/testkit';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'acp-relay.ts');

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

const request = (id: number): string => JSON.stringify({ jsonrpc: '2.0', id, method: 'session/list', params: {} });

describe('an ACP client moved by the relay', () => {
  it('a request written after the move began is answered once, by the new process, even when half of it was read by the old one', async () => {
    const folder = createTempDir();
    folders.push(folder);
    const child = fork(FIXTURE, ['old', path.join(folder, 'record.json')], { stdio: ['pipe', 'pipe', 'inherit', 'ipc'] });
    let output = '';
    const lines: string[] = [];
    let wake: () => void = () => undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const parts = output.split('\n');
      output = parts.pop() ?? '';
      lines.push(...parts);
      wake();
    });
    const answered = (count: number): Promise<void> =>
      new Promise((resolve) => {
        wake = () => {
          if (lines.length >= count) resolve();
        };
        wake();
      });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const second = request(2);
    child.stdin?.write(`${request(1)}\n`);
    await answered(1);
    child.stdin?.write(second.slice(0, 10));
    const held = new Promise<void>((resolve) => child.once('message', () => resolve()));
    child.send('move');
    await held;
    child.stdin?.write(`${second.slice(10)}\n`);
    await answered(2);
    child.stdin?.end();
    expect(await exited).toBe(0);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { jsonrpc: '2.0', id: 1, result: { by: 'old' } },
      { jsonrpc: '2.0', id: 2, result: { by: 'new' } },
    ]);
  });
});
