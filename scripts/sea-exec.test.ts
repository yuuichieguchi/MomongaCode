import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { buildSea } from './sea.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { RUNS_MACOS_ARM64_ARTIFACTS } from './support/host.ts';

type Finished = { status: number | null; stdout: string; stderr: string };

const SCRIPT_BINARY = '/usr/bin/script';
const ALTERNATE_SCREEN_ON = '\u001b[?1049h';
const ALTERNATE_SCREEN_OFF = '\u001b[?1049l';

const runToEnd = (file: string, args: readonly string[], env: NodeJS.ProcessEnv, input: string | undefined): Promise<Finished> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin?.end(input);
  });

const underPty = (binary: string, args: readonly string[]): readonly string[] =>
  process.platform === 'darwin' ? ['-q', '/dev/null', binary, ...args] : ['-q', '-e', '-c', [binary, ...args].join(' '), '/dev/null'];

describe.skipIf(!RUNS_MACOS_ARM64_ARTIFACTS)('process.execve inside the single executable', () => {
  let root = '';
  let binary = '';
  const env = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin', HOME: root, TERM: 'xterm-256color' });

  beforeAll(async () => {
    root = createTempRoot();
    binary = path.join(root, 'sea-fixture');
    await buildSea({ entry: `${repoRoot}test/fixtures/sea/entry.ts`, output: binary, workDir: path.join(root, 'work') });
  });

  afterAll(() => {
    removeTempRoot(root);
  });

  it('keeps the pid, hands on the arguments and keeps stdout and the unread stdin of the old image', async () => {
    const result = await runToEnd(binary, ['exec-probe'], env(), 'carried-line\n');
    const lines = result.stdout.split('\n').filter((line) => line !== '');
    expect(result.status).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^before-exec pid=\d+$/);
    const pid = lines[0]?.slice('before-exec pid='.length);
    expect(lines[1]).toBe(`after-exec pid-same=true token=handed-on stdin=carried-line argv=${JSON.stringify(['exec-probe-after', pid, 'handed-on'])}`);
  });

  it('keeps raw mode and the alternate screen of the terminal across the exec', async () => {
    const result = await runToEnd(SCRIPT_BINARY, underPty(binary, ['exec-tty']), env(), undefined);
    const output = result.stdout.replaceAll('\r', '');
    expect(output).toContain('before-exec icanon=off echo=off stty-status=0');
    expect(output).toContain('after-exec stdin-is-tty=true icanon=off echo=off stty-status=0');
    const switchedOn = output.indexOf(ALTERNATE_SCREEN_ON);
    const afterExec = output.indexOf('after-exec');
    expect(switchedOn).toBeGreaterThanOrEqual(0);
    expect(switchedOn).toBeLessThan(afterExec);
    expect(output.slice(switchedOn, afterExec)).not.toContain(ALTERNATE_SCREEN_OFF);
    expect(output.lastIndexOf(ALTERNATE_SCREEN_OFF)).toBeGreaterThan(afterExec);
  });
});
