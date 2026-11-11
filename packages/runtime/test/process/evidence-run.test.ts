import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { closeMarkerDescriptor, ensureMomongaDirs, momongaPaths, ruleEnforcementOf } from '@momonga/foundation';
import { SandboxPolicyError, createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxCommand, SandboxPolicy } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakePolicyFilesystem, pollUntil, withTempDir, testProcessInspector, TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { createEvidenceRunner } from '../../src/process/evidence-run.ts';
import { fixedSandboxBindings } from '@momonga/runtime';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const bytes = async function* (text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
};

const sandboxAnswering = (stdout: string, code: number | null) => {
  const spawned: { command: SandboxCommand; policy: SandboxPolicy; signal: AbortSignal }[] = [];
  const sandbox: Sandbox = {
    kind: 'none',
    spawn: (command, policy, signal, descriptors) => {
      spawned.push({ command, policy, signal });
      if (descriptors?.markerFd !== undefined) closeMarkerDescriptor(descriptors.markerFd);
      return { pid: 999_989, pgid: 999_989, stdout: bytes(stdout), stderr: bytes('ignored'), exited: Promise.resolve({ code, signal: null, stop: 'confirmed' }) };
    },
  };
  return { sandbox, spawned };
};

describe('the evidence runner', () => {
  it('runs the command in the sandbox with the project as the only writable root and no network, and returns the exit code and the output', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const { sandbox, spawned } = sandboxAnswering('abc\n', 0);
    const run = createEvidenceRunner({ reap: { inspector: testProcessInspector() }, paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(sandbox), env: { PATH: '/usr/bin' } })(project);

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
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const { sandbox, spawned } = sandboxAnswering('', 0);
    const run = createEvidenceRunner({ reap: { inspector: testProcessInspector() }, paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(sandbox), env: { GIT_SSH_COMMAND: '/planted', GIT_DIR: '/elsewhere', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: '/planted' } })(project);
    await run({ argv: ['git', 'status'], cwd: project, env: {}, network: 'deny' }, new AbortController().signal);
    const env = spawned[0]?.command.env ?? {};
    expect(env['GIT_SSH_COMMAND']).toBeUndefined();
    expect(env['GIT_DIR']).toBeUndefined();
    expect(Object.values(env)).not.toContain('/planted');
  });

  it('passes an exit code of null through, because a signal is not an answer', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const { sandbox } = sandboxAnswering('', null);
    const run = createEvidenceRunner({ reap: { inspector: testProcessInspector() }, paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(sandbox), env: {} })(project);
    await expect(run({ argv: ['git', 'status'], cwd: project, env: {}, network: 'deny' }, new AbortController().signal)).resolves.toEqual({ exitCode: null, stdout: '' });
  });

  it('kills a child that hangs when the caller aborts, and answers with no exit code', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const real = createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform, killGraceMs: 200 });
    const pids: number[] = [];
    const sandbox: Sandbox = {
      kind: 'none',
      spawn: async (command, policy, signal) => {
        const child = real.spawn(command, policy, signal);
        pids.push((await child).pid);
        return child;
      },
    };
    const run = createEvidenceRunner({ reap: { inspector: testProcessInspector() }, paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(sandbox), env: {} })(project);
    const caller = new AbortController();
    const answer = run({ argv: ['/bin/sleep', '60'], cwd: project, env: {}, network: 'deny' }, caller.signal);
    await pollUntil(() => pids.length === 1, { description: 'the evidence command to be spawned', boundMs: REAL_PROCESS_TEST_TIMEOUT_MS / 2 });
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

  it('starts nothing for a project that is not a folder', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const { sandbox, spawned } = sandboxAnswering('', 0);
    const run = createEvidenceRunner({ reap: { inspector: testProcessInspector() }, paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(sandbox), env: {} })('/no/such/project');
    await run({ argv: ['git', 'status'], cwd: '/no/such/project', env: {}, network: 'deny' }, new AbortController().signal);
    expect(spawned).toEqual([]);
  });

  describe('a spawn that could not start', () => {
    const errno = (code: string, message: string): Error => Object.assign(new Error(message), { code });

    const failures: [string, () => Error][] = [
      ['a refusal of the sandbox policy', () => new SandboxPolicyError('writable_root_not_absolute', 'refused')],
      ['a journal that cannot be written', () => errno('ENOSPC', 'no space left on device')],
      ['too many open files', () => errno('EMFILE', 'too many open files')],
      ['a plain error', () => new Error('the placeholder journal failed')],
      ['a type error', () => new TypeError('a defect')],
    ];

    for (const [label, make] of failures) {
      it(`is answered as a command that cannot be checked at the boundary of the runner, for ${label}`, async (context) => {
        const home = withTempDir(context, { asHome: true });
        const paths = momongaPaths(home, process.platform, process.env);
        await ensureMomongaDirs(paths);
        const project = fs.realpathSync(withTempDir(context));
        const failure = make();
        const sandbox: Sandbox = {
          kind: 'none',
          spawn: () => {
            throw failure;
          },
        };
        const run = createEvidenceRunner({ reap: { inspector: testProcessInspector() }, paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(sandbox), env: {} })(project);
        await expect(run({ argv: ['git', 'status'], cwd: project, env: {}, network: 'deny' }, new AbortController().signal)).resolves.toEqual({ exitCode: null, notStarted: failure.message });
      });
    }

    it('answers a project that is not a folder the same way', async (context) => {
      const home = withTempDir(context, { asHome: true });
      const paths = momongaPaths(home, process.platform, process.env);
      await ensureMomongaDirs(paths);
      const { sandbox } = sandboxAnswering('', 0);
      const run = createEvidenceRunner({ reap: { inspector: testProcessInspector() }, paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(sandbox), env: {} })('/no/such/project');
      const result = await run({ argv: ['git', 'status'], cwd: '/no/such/project', env: {}, network: 'deny' }, new AbortController().signal);
      expect(result).toEqual({ exitCode: null, notStarted: expect.stringContaining('/no/such/project') });
    });
  });

  it('lets an error of our own after the process ran stay an error', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const sandbox: Sandbox = {
      kind: 'none',
      spawn: () => ({
        pid: 1,
        pgid: 1,
        stdout: (async function* (): AsyncGenerator<Uint8Array> {
          yield new TextEncoder().encode('partial');
          throw new TypeError('reading the output failed');
        })(),
        stderr: bytes(''),
        exited: Promise.resolve({ code: 0, signal: null, stop: 'confirmed' }),
      }),
    };
    const run = createEvidenceRunner({ reap: { inspector: testProcessInspector() }, paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(sandbox), env: {} })(project);
    await expect(run({ argv: ['git', 'status'], cwd: project, env: {}, network: 'deny' }, new AbortController().signal)).rejects.toThrow('reading the output failed');
  });

  it('reads the output of the command through the bounded window: ten megabytes come back as the last bytes the window holds, with the count of the bytes left out', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, process.env);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const windowBytes = 1024;
    const chunkBytes = 64 * 1024;
    const chunkCount = 160;
    const flood = (fill: string) =>
      (async function* (): AsyncGenerator<Uint8Array> {
        for (let index = 0; index < chunkCount; index += 1) yield Buffer.alloc(chunkBytes, index === chunkCount - 1 ? 'z' : fill);
      })();
    const sandbox: Sandbox = {
      kind: 'none',
      spawn: (_command, _policy, _signal, descriptors) => {
        if (descriptors?.markerFd !== undefined) closeMarkerDescriptor(descriptors.markerFd);
        return { pid: 999_988, pgid: 999_988, stdout: flood('a'), stderr: flood('e'), exited: Promise.resolve({ code: 0, signal: null, stop: 'confirmed' }) };
      },
    };
    const run = createEvidenceRunner({ reap: { inspector: testProcessInspector() }, paths, home, fs: fakePolicyFilesystem(), sandboxes: fixedSandboxBindings(sandbox), env: {}, outputWindowBytes: windowBytes })(project);

    const result = await run({ argv: ['git', 'log'], cwd: project, env: {}, network: 'deny' }, new AbortController().signal);

    expect(result).toEqual({ exitCode: 0, stdout: 'z'.repeat(windowBytes), stdoutOmittedBytes: chunkCount * chunkBytes - windowBytes });
  });
});
