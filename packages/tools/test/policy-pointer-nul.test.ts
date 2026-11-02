import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRealWorkspace } from './real-workspace.ts';
import type { RealWorkspace } from './real-workspace.ts';

const gitdirLayout = (workspace: RealWorkspace, name: string, commondir: string, realIsGitDirectory: boolean): string => {
  workspace.write(`${name}/HEAD`, 'ref: refs/heads/main\n');
  workspace.mkdir(`${name}/objects`);
  workspace.mkdir(`${name}/refs`);
  workspace.mkdir(`${name}/sub`);
  workspace.write(`${name}/commondir`, commondir);
  workspace.mkdir(`${name}-real`);
  if (realIsGitDirectory) {
    workspace.mkdir(`${name}-real/objects`);
    workspace.mkdir(`${name}-real/refs`);
  }
  return path.join(workspace.project, name, 'sub');
};

describe('a NUL byte in a pointer file ends the text, as it does for real git (item 9)', () => {
  it('follows a commondir cut at the NUL to a valid git directory, and decides as for the same text without the NUL', () => {
    const workspace = makeRealWorkspace();
    const cwd = gitdirLayout(workspace, 'with-nul', '../with-nul-real\0x', true);
    const plainCwd = gitdirLayout(workspace, 'plain', '../plain-real', true);
    const decision = workspace.decide('git status', { cwd });
    expect(decision.kind).toBe('ask');
    expect(workspace.decide('git status', { cwd: plainCwd }).kind).toBe(decision.kind);
  });

  it('passes over a layout whose cut commondir is not a git directory, as git does, and approves git status', () => {
    const workspace = makeRealWorkspace();
    const cwd = gitdirLayout(workspace, 'nul', '../nul-real\0x', false);
    expect(workspace.git(cwd, 'rev-parse', '--git-common-dir').status).toBe(128);
    expect(workspace.decide('git status', { cwd }).kind).toBe('allow');
  });

  it('keeps a line end that precedes the NUL in a .git file: git follows the directory named with the newline, and so does the decision', () => {
    const workspace = makeRealWorkspace();
    workspace.mkdir('n2');
    const evil = path.join(workspace.project, 'evil\n');
    workspace.mkdir('evil\n/objects');
    workspace.mkdir('evil\n/refs');
    workspace.write('evil\n/HEAD', 'ref: refs/heads/main\n');
    workspace.write('n2/.git', 'gitdir: ../evil\n\0x');
    const cwd = path.join(workspace.project, 'n2');
    expect(workspace.git(cwd, 'rev-parse', '--git-dir').stdout).toBe(`${evil}\n`);
    expect(workspace.decide('git status', { cwd }).kind).toBe('ask');
  });

  it('keeps a line end that precedes the NUL in a commondir file', () => {
    const workspace = makeRealWorkspace();
    const cwd = gitdirLayout(workspace, 'cd', '../cd-real\n\0x', false);
    workspace.mkdir('cd-real\n/objects');
    workspace.mkdir('cd-real\n/refs');
    expect(workspace.git(cwd, 'rev-parse', '--git-common-dir').status).toBe(0);
    expect(workspace.decide('git status', { cwd }).kind).toBe('ask');
  });

  it('follows a .git file cut at the NUL, and decides as for the same text without the NUL', () => {
    const workspace = makeRealWorkspace();
    workspace.mkdir('sub');
    const real = path.join(workspace.outside, 'real');
    workspace.mkdir(path.relative(workspace.project, path.join(real, 'objects')));
    workspace.mkdir(path.relative(workspace.project, path.join(real, 'refs')));
    workspace.write(path.relative(workspace.project, path.join(real, 'HEAD')), 'ref: refs/heads/main\n');
    workspace.write('.git', 'gitdir: ../outside/real\0x\n');
    const cwd = path.join(workspace.project, 'sub');
    expect(workspace.git(cwd, 'rev-parse', '--git-dir').stdout.trim()).toBe(real);
    const withNul = workspace.decide('git status', { cwd });
    workspace.write('.git', 'gitdir: ../outside/real\n');
    expect(workspace.decide('git status', { cwd }).kind).toBe(withNul.kind);
  });
});
