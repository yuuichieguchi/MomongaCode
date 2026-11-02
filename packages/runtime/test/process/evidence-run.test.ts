import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOST_RULE_ENFORCEMENT, ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { SandboxPolicyError, createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxCommand, SandboxPolicy } from '@momonga/sandbox';
import { fakePolicyFilesystem, withTempDir } from '@momonga/testkit';
import { createEvidenceRunner } from '../../src/process/evidence-run.ts';

const bytes = async function* (text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
};

const sandboxAnswering = (stdout: string, code: number | null) => {
  const spawned: { command: SandboxCommand; policy: SandboxPolicy; signal: AbortSignal }[] = [];
  const sandbox: Sandbox = {
    kind: 'none',
    spawn: (command, policy, signal) => {
      spawned.push({ command, policy, signal });
      return { pid: 1, pgid: 1, stdout: bytes(stdout), stderr: bytes('ignored'), exited: Promise.resolve({ code, signal: null }) };
    },
  };
  return { sandbox, spawned };
};

describe('the evidence runner', () => {
  it('runs the command in the sandbox with the project as the only writable root and no network, and returns the exit code and the output', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const { sandbox, spawned } = sandboxAnswering('abc\n', 0);
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), enforcement: HOST_RULE_ENFORCEMENT,sandbox, env: { PATH: '/usr/bin' } })(project);

    const caller = new AbortController();
    const result = await run({ argv: ['git', 'rev-parse', 'HEAD'], cwd: project, env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, network: 'deny' }, caller.signal);

    expect(result).toEqual({ exitCode: 0, stdout: 'abc\n' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.signal).toBe(caller.signal);
    const command = spawned[0]?.command;
    expect(command?.argv).toEqual(['git', 'rev-parse', 'HEAD']);
    expect(command?.cwd).toBe(project);
    expect(command && 'tmpDir' in command).toBe(false);
    expect(command?.env).toMatchObject({
      PATH: '/usr/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
    });
    expect(spawned[0]?.policy.network).toBe('deny');
    expect(spawned[0]?.policy.writableRoots).toEqual([]);
    expect(spawned[0]?.policy.readAllowed ?? []).toEqual([]);
  });

  it('clears the git variables that name a program or a repository, whatever the daemon environment holds', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const { sandbox, spawned } = sandboxAnswering('', 0);
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), enforcement: HOST_RULE_ENFORCEMENT,sandbox, env: { GIT_SSH_COMMAND: '/planted', GIT_DIR: '/elsewhere', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: '/planted' } })(project);
    await run({ argv: ['git', 'status'], cwd: project, env: {}, network: 'deny' }, new AbortController().signal);
    const env = spawned[0]?.command.env ?? {};
    expect(env['GIT_SSH_COMMAND']).toBeUndefined();
    expect(env['GIT_DIR']).toBeUndefined();
    expect(Object.values(env)).not.toContain('/planted');
  });

  it('passes an exit code of null through, because a signal is not an answer', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const { sandbox } = sandboxAnswering('', null);
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), enforcement: HOST_RULE_ENFORCEMENT,sandbox, env: {} })(project);
    await expect(run({ argv: ['git', 'status'], cwd: project, env: {}, network: 'deny' }, new AbortController().signal)).resolves.toEqual({ exitCode: null, stdout: '' });
  });

  it('kills a child that hangs when the caller aborts, and answers with no exit code', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const real = createUnsandboxed({ killGraceMs: 200 });
    const pids: number[] = [];
    const sandbox: Sandbox = {
      kind: 'none',
      spawn: (command, policy, signal) => {
        const child = real.spawn(command, policy, signal);
        pids.push(child.pid);
        return child;
      },
    };
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), enforcement: HOST_RULE_ENFORCEMENT,sandbox, env: {} })(project);
    const caller = new AbortController();
    const answer = run({ argv: ['/bin/sleep', '60'], cwd: project, env: {}, network: 'deny' }, caller.signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    caller.abort();

    await expect(answer).resolves.toMatchObject({ exitCode: null });
    expect(pids).toHaveLength(1);
    const gone = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    };
    expect(gone(pids[0] ?? 0)).toBe(true);
  });

  it('answers that a project that is not a folder cannot be checked, and starts nothing', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const { sandbox, spawned } = sandboxAnswering('', 0);
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), enforcement: HOST_RULE_ENFORCEMENT,sandbox, env: {} })('/no/such/project');
    await expect(run({ argv: ['git', 'status'], cwd: '/no/such/project', env: {}, network: 'deny' }, new AbortController().signal)).resolves.toEqual({ exitCode: null });
    expect(spawned).toEqual([]);
  });

  it('answers that a command the sandbox refuses cannot be checked, but lets any other failure through', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const refusing: Sandbox = {
      kind: 'none',
      spawn: () => {
        throw new SandboxPolicyError('writable_root_not_absolute', 'refused');
      },
    };
    const broken: Sandbox = {
      kind: 'none',
      spawn: () => {
        throw new TypeError('a defect');
      },
    };
    const command = { argv: ['git', 'status'], cwd: project, env: {}, network: 'deny' as const };
    const signal = new AbortController().signal;
    await expect(createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), enforcement: HOST_RULE_ENFORCEMENT,sandbox: refusing, env: {} })(project)(command, signal)).resolves.toEqual({ exitCode: null });
    await expect(createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), enforcement: HOST_RULE_ENFORCEMENT,sandbox: broken, env: {} })(project)(command, signal)).rejects.toThrow('a defect');
  });
});
