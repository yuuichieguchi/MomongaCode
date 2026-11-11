import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EntryIo } from '@momonga/foundation';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram, createShellPort, exitOfFailure } from '../src/program.ts';
import type { ProgramDeps } from '../src/program.ts';
import { runMain } from '../src/run-main.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { NO_HELPER } from './no-helper.ts';

let home: string;
const initialArgv = process.argv;
const initialExitCode = process.exitCode;
const initialInterruptListeners = process.listeners('SIGINT');

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'momonga-usage-exit-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.argv = initialArgv;
  process.exitCode = initialExitCode;
  for (const listener of process.listeners('SIGINT')) if (!initialInterruptListeners.includes(listener)) process.off('SIGINT', listener);
});

const depsOf = (written: string[], completed: number[]): ProgramDeps => {
  const sink = { write: (text: string): boolean => (written.push(text), true) };
  const ports = { version: '9.9.9', home, cwd: home, platform: process.platform, interrupt: new AbortController().signal, terminal: undefined, stdout: sink, stderr: sink } as unknown as CliPorts;
  const entry = async (): Promise<number> => 0;
  return {
    ports,
    policyVerify: () => {
      throw new Error('policy verify is not part of this test');
    },
    entries: { supervise: entry, gateway: entry, runtime: entry },
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: (code) => void completed.push(code),
  };
};

const exitOf = async (argv: readonly string[]): Promise<{ code: number | undefined; written: string }> => {
  const written: string[] = [];
  const completed: number[] = [];
  const deps = depsOf(written, completed);
  try {
    await buildProgram(deps).parseAsync([...argv], { from: 'user' });
  } catch (error) {
    return { code: exitOfFailure(error, deps.ports.stderr), written: written.join('') };
  }
  return { code: completed.at(-1), written: written.join('') };
};

describe('the exit code of a command line that cannot be run', () => {
  it('is 2 for an unknown option of the root, said once', async () => {
    const result = await exitOf(['--bogus']);
    expect(result.code).toBe(2);
    expect(result.written.match(/unknown option '--bogus'/g)).toHaveLength(1);
  });

  it('is 2 for an unknown option of a subcommand', async () => {
    const result = await exitOf(['eval', 'bench', 'tasks', '--bogus']);
    expect(result.code).toBe(2);
    expect(result.written).toContain("unknown option '--bogus'");
  });

  it('is 2 for an option value commander refuses', async () => {
    expect((await exitOf(['attach', '--after', 'soon'])).code).toBe(2);
  });

  it('is 2 for an unknown command word under a group', async () => {
    expect((await exitOf(['daemon', 'restartt'])).code).toBe(2);
  });

  it('is 2 for a usage error the product itself raises, by the type of the error', async () => {
    const result = await exitOf(['eval', 'bench', 'tasks']);
    expect(result.code).toBe(2);
    expect(result.written).toContain('momonga: --model <model> is required');
  });

  it('is 2 for the usage error of cost and of elicit', async () => {
    expect((await exitOf(['cost', 'run-1', '--all'])).code).toBe(2);
    expect((await exitOf(['elicit', '--accept'])).code).toBe(2);
  });

  it('is 1 for a refusal', async () => {
    const result = await exitOf([]);
    expect(result.code).toBe(1);
    expect(result.written).toContain('momonga: the interactive session needs a terminal');
  });

  it('is 0 for help and for the version, of the root and of a subcommand', async () => {
    expect((await exitOf(['--help'])).code).toBe(0);
    expect((await exitOf(['--version'])).code).toBe(0);
    expect((await exitOf(['daemon', 'status', '--help'])).code).toBe(0);
  });

  it('is the same 2 from a command embedded in the interactive session, whose host goes on', async () => {
    const written: string[] = [];
    const shell = createShellPort(depsOf([], []));
    const io = { write: (text: string): void => void written.push(text), signal: new AbortController().signal };
    expect(await shell.run(['cost', '--bogus'], io)).toBe(2);
    expect(await shell.run(['--bogus'], io)).toBe(2);
    expect(await shell.run(['cost', '--help'], io)).toBe(0);
  });
});

describe('runMain', () => {
  it('ends a command line with an unknown option with 2 and a subcommand help with 0', async () => {
    const written: string[] = [];
    const sink = { write: (text: string): boolean => (written.push(text), true) };
    process.argv = ['node', 'momonga', 'daemon', 'status', '--bogus'];
    await runMain('9.9.9', { home, stdout: sink, stderr: sink });
    expect(process.exitCode).toBe(2);
    expect(written.join('').match(/unknown option '--bogus'/g)).toHaveLength(1);

    process.argv = ['node', 'momonga', 'daemon', 'status', '--help'];
    await runMain('9.9.9', { home, stdout: sink, stderr: sink });
    expect(process.exitCode).toBe(0);
  });
});
