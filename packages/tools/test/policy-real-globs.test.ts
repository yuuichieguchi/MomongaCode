import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeRealWorkspace } from './real-workspace.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const ALLOW_CAT = [['allow', 'Bash(cat:*)']] as const;

describe('a glob or brace read operand is judged by the files it expands to (real /bin/bash)', () => {
  it('bash reads every brace alternative and every glob match', () => {
    const workspace = makeRealWorkspace();
    workspace.write('a', 'A\n');
    workspace.write('b', 'B\n');
    workspace.write('f1', '1\n');
    workspace.write('f2', '2\n');
    expect(workspace.runBash('cat {a,b} f{1..2}').stdout).toBe('A\nB\n1\n2\n');
  });

  it.each(['cat {/etc/passwd,x}', 'cat /etc/{passwd,hosts}', 'cat /etc/pass*', 'cat {,/etc/}passwd'])('asks for %s under Bash(cat:*) and denies it under Read(//etc/passwd)', async (command) => {
    const workspace = makeRealWorkspace();
    expect((await workspace.decideExpanding(command, { rules: ALLOW_CAT })).kind).toBe('ask');
    expect((await workspace.decideExpanding(command, { rules: [...ALLOW_CAT, ['deny', 'Read(//etc/passwd)']] })).kind).toBe('deny');
  });

  it('asks when a glob matches a repository-shipped link that leaves the workspace', async () => {
    const workspace = makeRealWorkspace();
    const secret = path.join(workspace.outside, 'secret');
    workspace.write('../outside/secret', 'TOP\n');
    workspace.link(secret, 'lnk');
    expect(workspace.runBash('cat l*').stdout).toBe('TOP\n');
    expect((await workspace.decideExpanding('cat l*', { rules: ALLOW_CAT })).kind).toBe('ask');
    expect((await workspace.decideExpanding('cat l*')).kind).toBe('ask');
  });

  it('allows globs and braces whose matches stay inside the workspace', async () => {
    const workspace = makeRealWorkspace();
    workspace.write('a', 'A\n');
    workspace.write('b', 'B\n');
    expect((await workspace.decideExpanding('cat {a,b}', { rules: ALLOW_CAT })).kind).toBe('allow');
    expect((await workspace.decideExpanding('cat *', { rules: ALLOW_CAT })).kind).toBe('allow');
  });

  it('asks when an expansion exceeds the match limit', () => {
    const workspace = makeRealWorkspace();
    expect(workspace.decide('cat f{1..5000}', { rules: ALLOW_CAT }).kind).toBe('ask');
  });
});
