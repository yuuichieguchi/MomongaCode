import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_LAUNCH, hostProcessGroupPort, launchGroupLeader, systemTiming } from '@momonga/foundation';
import { createTempDir, pollUntil, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createWorkspaceProbe, nodeWorkspaceFiles } from '../src/index.ts';
import type { CommandSandbox, WorkspaceProbe } from '../src/index.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

let root = '';
let dir = '';
let base = '';

const seed = (target: string): void => {
  fs.mkdirSync(path.join(target, 'src'), { recursive: true });
  fs.writeFileSync(path.join(target, 'check.sh'), 'test -f done.txt\n');
  fs.writeFileSync(path.join(target, 'src', 'a.txt'), 'a');
};

beforeEach(() => {
  root = createTempDir();
  dir = path.join(root, 'work');
  base = path.join(root, 'base');
  seed(dir);
  seed(base);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const launched = async (file: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>) => {
  const { pgid, onExit } = await launchGroupLeader({ file, args, cwd, env, stdio: ['ignore', 'ignore', 'ignore'], protection: CONTROL_PLANE_LAUNCH });
  if (pgid === undefined) throw new Error(`${file} started with no process group`);
  return { pgid, exited: new Promise<{ code: number | null }>((resolve, reject) => onExit(({ code }) => resolve({ code }), reject)) };
};

const passThrough: CommandSandbox = { start: async (command, workspace, env) => launched('/bin/sh', ['-c', command], workspace, env) };

const probe = (sandbox: CommandSandbox = passThrough): WorkspaceProbe =>
  createWorkspaceProbe({ env: { PATH: '/usr/bin:/bin' }, sandbox, files: nodeWorkspaceFiles, timing: systemTiming, groups: hostProcessGroupPort() });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

describe('the one workspace probe', () => {
  it('runs a command in the workspace through the command sandbox and reports its exit code', async () => {
    const asked: { command: string; workspace: string }[] = [];
    const recording: CommandSandbox = { start: async (command, workspace, env, signal) => (asked.push({ command, workspace }), passThrough.start(command, workspace, env, signal)) };
    expect(await probe(recording).run('sh check.sh', 30_000, dir)).toEqual({ exitCode: 1, timedOut: false });
    fs.writeFileSync(path.join(dir, 'done.txt'), '');
    expect(await probe(recording).run('sh check.sh', 30_000, dir)).toEqual({ exitCode: 0, timedOut: false });
    expect(asked).toEqual([
      { command: 'sh check.sh', workspace: dir },
      { command: 'sh check.sh', workspace: dir },
    ]);
  });

  it.skipIf(process.platform === 'win32')('kills the whole process group of a command that outruns its timeout, a grandchild with it', async () => {
    const pidFile = path.join(dir, 'grandchild.pid');
    expect(await probe().run(`sleep 30 & echo $! > ${pidFile}; wait`, 500, dir)).toEqual({ exitCode: null, timedOut: true });
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await pollUntil(() => !alive(grandchild), { description: 'the grandchild is gone', boundMs: 10_000 });
    expect(alive(grandchild)).toBe(false);
  });

  it('gives the same digest for the same workspace, and changes it only when a named file changes', async () => {
    const before = await probe().digest(dir, ['src/a.txt', 'check.sh']);
    expect(await probe().digest(base, ['check.sh', 'src/a.txt'])).toBe(before);
    fs.writeFileSync(path.join(dir, 'done.txt'), 'x');
    expect(await probe().digest(dir, ['src/a.txt', 'check.sh'])).toBe(before);
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'changed');
    expect(await probe().digest(dir, ['src/a.txt', 'check.sh'])).not.toBe(before);
  });

  it('lists the files that differ from the base, whether edited, added or deleted', async () => {
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'edited');
    fs.writeFileSync(path.join(dir, 'done.txt'), '');
    fs.rmSync(path.join(dir, 'check.sh'));
    expect(await probe().changedPaths(dir, base)).toEqual(['check.sh', 'done.txt', 'src/a.txt']);
  });

  it.skipIf(process.platform === 'win32')('reads a symlink to a directory as a link and a FIFO by its type, never following or opening them', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    fs.symlinkSync(outside, path.join(dir, 'linked'));
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    expect(await probe().changedPaths(dir, base)).toEqual(['linked', 'pipe']);
    const withLink = await probe().digest(dir, ['linked', 'pipe']);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'changed outside');
    expect(await probe().digest(dir, ['linked', 'pipe'])).toBe(withLink);
    fs.rmSync(path.join(dir, 'linked'));
    fs.symlinkSync(base, path.join(dir, 'linked'));
    expect(await probe().digest(dir, ['linked', 'pipe'])).not.toBe(withLink);
  });
});
