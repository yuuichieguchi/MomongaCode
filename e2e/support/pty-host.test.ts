import { spawn } from '@momonga/testkit/child-process';
import { describe, expect, it } from 'vitest';
import { PTY_HOST, PYTHON_BINARY } from './pty.ts';
import { E2E_MARGIN_MS, withinBound } from './wait.ts';

const runUnderPty = async (script: string, input: string): Promise<{ output: string; code: number | null }> => {
  const child = spawn(PYTHON_BINARY, [PTY_HOST, '100', '40', '/bin/sh', '-c', script], { stdio: ['pipe', 'pipe', 'ignore'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  child.stdin.write(input);
  const code = await withinBound(closed, E2E_MARGIN_MS, 'the command under the pty host to exit');
  return { output, code };
};

describe('the pty host of the e2e tests', () => {
  it('gives the command a terminal of the stated size, delivers typed input to it and returns its exit code, on every platform it runs on', async () => {
    const { output, code } = await runUnderPty('stty size; read line; echo "got:$line"; exit 3', 'typed\r');
    expect(output).toContain('40 100');
    expect(output).toContain('got:typed');
    expect(code).toBe(3);
  });

  it('delivers input that arrives after the command started reading', async () => {
    const { output, code } = await runUnderPty('printf "ready\\n"; read first; read second; echo "got:$first+$second"', 'one\rtwo\r');
    expect(output).toContain('got:one+two');
    expect(code).toBe(0);
  });
});
