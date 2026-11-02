import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureMomongaDirs, momongaPaths } from '@momonga/foundation';
import type { Sandbox, SandboxCommand, SandboxPolicy } from '@momonga/sandbox';
import { fakePolicyFilesystem, withTempDir } from '@momonga/testkit';
import { EVIDENCE_TMP_ID, createEvidenceRunner } from '../../src/process/evidence-run.ts';

const tmpDirOf = (paths: ReturnType<typeof momongaPaths>): string => path.join(paths.tmp.sessions, EVIDENCE_TMP_ID);

const bytes = async function* (text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
};

const sandboxAnswering = (stdout: string, code: number | null) => {
  const spawned: { command: SandboxCommand; policy: SandboxPolicy }[] = [];
  const sandbox: Sandbox = {
    kind: 'none',
    spawn: (command, policy) => {
      spawned.push({ command, policy });
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

    const result = await run({ argv: ['git', 'rev-parse', 'HEAD'], cwd: project, env: { GIT_TERMINAL_PROMPT: '0' }, network: 'deny' });

    expect(result).toEqual({ exitCode: 0, stdout: 'abc\n' });
    expect(spawned).toHaveLength(1);
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
    await expect(run({ argv: ['git', 'status'], cwd: project, env: {}, network: 'deny' })).resolves.toEqual({ exitCode: null, stdout: '' });
  });

  it('refuses a project that is not a folder', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home);
    await ensureMomongaDirs(paths);
    const { sandbox } = sandboxAnswering('', 0);
    const run = createEvidenceRunner({ paths, home, fs: fakePolicyFilesystem(), sandbox, env: {} })('/no/such/project');
    await expect(run({ argv: ['git', 'status'], cwd: '/no/such/project', env: {}, network: 'deny' })).rejects.toThrow('/no/such/project');
  });
});
