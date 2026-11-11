import { momongaPaths } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import type { CliPorts } from '../src/ports.ts';
import { createTuiBackend } from '../src/tui/backend.ts';
import { AUTHORIZATION_URL } from './fake-plan-gateway.tsx';

const capture = (into: string[]) => ({ write: (chunk: string | Uint8Array) => (into.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')), true) });

describe('the clipboard port of the TUI backend (O-R5-6 C)', () => {
  it('writes the one OSC 52 sequence of the text, unescaped, and nothing else', async () => {
    const written: string[] = [];
    const ports = {
      version: '1.2.3',
      env: {},
      home: '/home/alice',
      cwd: '/home/alice/project',
      clock: { now: () => 0, sleep: async () => undefined },
      stdout: capture(written),
      stderr: capture(written),
      terminal: { stdin: process.stdin, stdout: capture(written) },
    } as unknown as CliPorts;
    const backend = createTuiBackend(ports, momongaPaths('/home/alice', process.platform, process.env), {}, { load: async () => [], append: async () => undefined }, []);
    const href = new URL(AUTHORIZATION_URL).href;

    await (backend as unknown as { copyToClipboard(text: string): void | Promise<void> }).copyToClipboard(href);

    expect(written.join('')).toBe(`\u001b]52;c;${Buffer.from(href, 'utf8').toString('base64')}\u0007`);
  });
});
