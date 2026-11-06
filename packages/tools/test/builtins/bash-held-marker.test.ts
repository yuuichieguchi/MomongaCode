import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProcessInspector, hostInspectorPorts, nodeCommandRunner } from '@momonga/foundation';
import type { CommandOptions, CommandRunner } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { HAS_REAL_SANDBOX, keyFor } from '../helpers.ts';
import { makeBuiltins, resultOf, waitFor } from './fixtures.ts';

const PROCESS_TIMEOUT = { timeout: REAL_PROCESS_TEST_TIMEOUT_MS };

const LSOF = '/usr/sbin/lsof';

const notProved = { of: async () => 'unenforced' as const, contradicted: () => undefined };
const proved = { of: async () => 'proved' as const, contradicted: () => undefined };

type Recorded = { file: string; options: CommandOptions };

const killedByTimeout = (): Error => Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGKILL' });

const slowLsof = (latencyMs: number, calls: Recorded[]): CommandRunner => async (file, args, options) => {
  if (file === LSOF) {
    calls.push({ file, options });
    if (options.timeoutMs !== undefined && options.timeoutMs < latencyMs) throw killedByTimeout();
  }
  return nodeCommandRunner(file, args, options);
};

const failingLsof = (calls: Recorded[]): CommandRunner => async (file, args, options) => {
  if (file === LSOF) {
    calls.push({ file, options });
    return { exitCode: 1, stdout: '', stderr: 'lsof: WARNING: injected listing failure\n' };
  }
  return nodeCommandRunner(file, args, options);
};

const forbiddenLsof = (calls: Recorded[]): CommandRunner => async (file, args, options) => {
  if (file === LSOF) {
    calls.push({ file, options });
    throw new Error('the lock path must not list holders');
  }
  return nodeCommandRunner(file, args, options);
};

const builtinsWith = (run: CommandRunner, capability: typeof notProved | typeof proved) =>
  makeBuiltins({ realSandbox: true, executor: { reap: { inspector: createProcessInspector(process.platform, { ...hostInspectorPorts(), run, capability } as never) } } });

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ESCAPED = (ready: string) => `perl -e 'use POSIX; POSIX::setsid(); open(my $f, ">", $ARGV[0]); close $f; sleep 30' ${ready} >/dev/null 2>&1 & while [ ! -e ${ready} ]; do sleep 0.05; done; echo "pid:$!"; echo ok`;

describe.runIf(HAS_REAL_SANDBOX && process.platform === 'darwin')('T0 Bash with a listing that takes 6000 ms', () => {
  it('(a) F not proved: returns the real output, stops the holder the listing named, and asks lsof without any private timeout under the call signal', PROCESS_TIMEOUT, async () => {
    const calls: Recorded[] = [];
    const tools = await builtinsWith(slowLsof(6000, calls), notProved);
    const ready = path.join(tools.layout.project, 'ready');
    const result = resultOf(await tools.run('Bash', { command: ESCAPED(ready) }, {}, 'allow_once', 'slow'));
    const escaped = Number(/pid:(\d+)/.exec(result.output)?.[1]);
    expect(result.status).toBe('completed');
    expect(result.output).not.toContain('Internal error');
    expect(result.output).toContain('ok');
    expect(result.output).toContain('Terminated 1 process(es) that outlived the command.');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.options.timeoutMs === undefined && call.options.signal instanceof AbortSignal)).toBe(true);
    expect(await waitFor(() => !isAlive(escaped), 10_000)).toBe(true);
  });

  it('(b) F proved: a command that leaves nothing behind is settled by the lock and lsof is never run', PROCESS_TIMEOUT, async () => {
    const calls: Recorded[] = [];
    const tools = await builtinsWith(forbiddenLsof(calls), proved);
    const result = resultOf(await tools.run('Bash', { command: 'echo ok' }, {}, 'allow_once', 'quiet'));
    expect(result).toMatchObject({ status: 'completed', output: 'ok' });
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(tools.markerDir, keyFor('run-1', 1, 'quiet')))).toBe(false);
  });
});

describe.runIf(HAS_REAL_SANDBOX && process.platform === 'darwin')('T2 Bash when the holder state is not free', () => {
  it('a failed listing returns the real result with the unknown note, keeps the marker and stops nothing', PROCESS_TIMEOUT, async () => {
    const calls: Recorded[] = [];
    const tools = await builtinsWith(failingLsof(calls), notProved);
    const result = resultOf(await tools.run('Bash', { command: 'echo ok' }, {}, 'allow_once', 'unknown'));
    expect(result.status).toBe('completed');
    expect(result.output.startsWith('ok\n')).toBe(true);
    expect(result.output).toContain('Note: the command finished (exit code 0) and its output is above. MomongaCode could not check whether a process started by it is still running (');
    expect(result.output).toContain('Nothing was stopped. It will check again before the next command that runs a process or changes files in this session.');
    expect(calls.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tools.markerDir, keyFor('run-1', 1, 'unknown')))).toBe(true);
  });

  it('a failed command keeps its own status and exit code when the holder state is unknown', PROCESS_TIMEOUT, async () => {
    const tools = await builtinsWith(failingLsof([]), notProved);
    const result = resultOf(await tools.run('Bash', { command: 'echo before; exit 3' }, {}, 'allow_once', 'failed-unknown'));
    expect(result).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(result.output).toContain('Note: the command finished (exit code 3)');
    expect(fs.existsSync(path.join(tools.markerDir, keyFor('run-1', 1, 'failed-unknown')))).toBe(true);
  });
});
