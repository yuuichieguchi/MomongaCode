import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { replaceProcess } from '../../src/handover/replace-process.ts';
import type { ReplaceHost, ReplaceTarget } from '../../src/handover/replace-process.ts';

const exitWith = (code: number): ReplaceTarget => ({ file: process.execPath, args: ['-e', `process.exit(${code})`], env: { PATH: '/usr/bin:/bin' } });

describe('the handover replaces the process in place where the host reports execve, and relays otherwise', () => {
  it('calls execve with the target file as argv[0] followed by the arguments and the environment', async () => {
    const calls: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const spawned: string[] = [];
    const target = exitWith(7);
    const replaced = Promise.resolve().then(() => replaceProcess(target, {
      execve: ((file: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
        calls.push({ file, args, env });
        throw new Error('execve returned control');
      }) as ReplaceHost['execve'],
      spawn: ((file: string) => {
        spawned.push(file);
        throw new Error('the relay must not run when execve is present');
      }) as unknown as typeof spawn,
      exit: () => undefined,
    }));
    await expect(replaced).rejects.toThrow('execve returned control');
    expect(calls).toEqual([{ file: process.execPath, args: [process.execPath, '-e', 'process.exit(7)'], env: { PATH: '/usr/bin:/bin' } }]);
    expect(spawned).toEqual([]);
  });

  it('runs the target as a child with inherited stdio and exits with its status when the host has no execve', async () => {
    const exits: number[] = [];
    const stdios: unknown[] = [];
    const recordingSpawn = ((file: string, args: readonly string[], options: { stdio?: unknown }) => {
      stdios.push(options.stdio);
      return spawn(file, args, { ...options, stdio: 'ignore' });
    }) as unknown as typeof spawn;
    expect(await replaceProcess(exitWith(7), { execve: undefined, spawn: recordingSpawn, exit: (code) => exits.push(code) })).toBe('relayed');
    expect(exits).toEqual([7]);
    expect(stdios).toEqual(['inherit']);
  });
});
