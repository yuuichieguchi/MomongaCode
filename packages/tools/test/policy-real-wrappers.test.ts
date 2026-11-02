import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRealWorkspace } from './real-workspace.ts';
import type { RealWorkspace } from './real-workspace.ts';

const plantProgram = (workspace: RealWorkspace, name: string): string => {
  workspace.write(`bin/${name}`, '#!/bin/sh\ntouch planted\n', 0o755);
  return `${path.join(workspace.project, 'bin')}:/usr/bin:/bin`;
};

describe('builtins and keywords run as programs behind a program wrapper (real /bin/bash)', () => {
  it.each(['nice echo hi', 'nohup pwd', 'nice time ls', 'nice command echo hi'])(
    'asks for %s when a planted program of that name comes first on PATH, and the planted program runs',
    (command) => {
      const workspace = makeRealWorkspace();
      const word = command.split(' ').find((candidate) => ['echo', 'pwd', 'time', 'command'].includes(candidate)) as string;
      const searchPath = plantProgram(workspace, word);
      workspace.runBash(command, workspace.project, { PATH: searchPath });
      expect(workspace.exists('planted')).toBe(true);
      expect(workspace.decide(command, { searchPath }).kind).toBe('ask');
    },
  );

  it.each(['nice echo hi', 'nohup pwd', 'time echo hi', 'command echo hi', 'nice ls'])('allows %s with the Apple programs on PATH', (command) => {
    const workspace = makeRealWorkspace();
    expect(workspace.decide(command).kind).toBe('allow');
  });

  it('keeps the shell builtin reading for the shell-level wrappers', () => {
    const workspace = makeRealWorkspace();
    const searchPath = plantProgram(workspace, 'echo');
    workspace.runBash('command echo hi', workspace.project, { PATH: searchPath });
    expect(workspace.exists('planted')).toBe(false);
    expect(workspace.decide('command echo hi', { searchPath }).kind).toBe('allow');
    expect(workspace.decide('time echo hi', { searchPath }).kind).toBe('allow');
  });
});
