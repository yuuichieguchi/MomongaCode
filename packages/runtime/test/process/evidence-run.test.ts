import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import { createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxCommand, SandboxPolicy } from '@momonga/sandbox';
import { fakePolicyFilesystem, withTempDir } from '@momonga/testkit';
import { EVIDENCE_TMP_ID, createEvidenceRunner } from '../../src/process/evidence-run.ts';

const tmpDirOf = (paths: ReturnType<typeof momongaPaths>): string => path.join(paths.tmp.sessions, EVIDENCE_TMP_ID);

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
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), sandbox, env: { PATH: '/usr/bin' } })(project);

    const caller = new AbortController();
    const result = await run({ argv: ['git', 'rev-parse', 'HEAD'], cwd: project, env: { GIT_TERMINAL_PROMPT: '0' }, network: 'deny' }, caller.signal);

    expect(result).toEqual({ exitCode: 0, stdout: 'abc\n' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.signal).toBe(caller.signal);
    expect(spawned[0]?.command).toEqual({ argv: ['git', 'rev-parse', 'HEAD'], cwd: project, env: { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' }, tmpDir: tmpDirOf(paths) });
    expect(spawned[0]?.policy.network).toBe('deny');
    expect(spawned[0]?.policy.writableRoots).toEqual([project, tmpDirOf(paths)]);
  });

  it('passes an exit code of null through, because a signal is not an answer', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const project = fs.realpathSync(withTempDir(context));
    const { sandbox } = sandboxAnswering('', null);
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), sandbox, env: {} })(project);
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
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), sandbox, env: {} })(project);
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

  it('refuses a project that is not a folder', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const { sandbox } = sandboxAnswering('', 0);
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), sandbox, env: {} })('/no/such/project');
    await expect(run({ argv: ['git', 'status'], cwd: '/no/such/project', env: {}, network: 'deny' }, new AbortController().signal)).rejects.toThrow('/no/such/project');
  });
});
