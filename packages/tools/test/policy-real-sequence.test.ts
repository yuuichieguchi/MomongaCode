import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeRealWorkspace } from './real-workspace.ts';
import type { RealWorkspace } from './real-workspace.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const withLinkToSecret = (workspace: RealWorkspace): void => {
  workspace.write('../outside/secret', 'TOP\n');
  workspace.link(path.join(workspace.outside, 'secret'), 'src/l');
  workspace.write('src/plain', 'ok\n');
};

describe('an earlier segment of the same command can change what a later operand resolves to (real /bin/bash)', () => {
  it('bash reads through the repository-shipped link after the directory was moved', () => {
    const workspace = makeRealWorkspace();
    withLinkToSecret(workspace);
    expect(workspace.runBash('mv src s2; cat s2/l').stdout).toBe('TOP\n');
  });

  it.each(['mv src s2; cat s2/l', 'cp -R src s2; cat s2/l', 'mv src s2 && echo "$(cat s2/l)"', 'cp -R src s2; cat s2/*'])('asks for %s in acceptEdits mode', async (command) => {
    const workspace = makeRealWorkspace();
    withLinkToSecret(workspace);
    expect((await workspace.decideExpanding(command, { mode: 'acceptEdits' })).kind).toBe('ask');
  });

  it('reads the moved directory by its old name as a missing path, not as a hole', () => {
    const workspace = makeRealWorkspace();
    withLinkToSecret(workspace);
    expect(workspace.decide('mv src s2; cat src/plain', { mode: 'acceptEdits' }).kind).toBe('ask');
  });

  it.each(['mv src s2; cat other/x', 'touch a; cat b', 'mkdir d; cat src/plain', 'cp src/plain copy; cat src/plain'])('keeps allowing %s when the paths do not overlap', (command) => {
    const workspace = makeRealWorkspace();
    withLinkToSecret(workspace);
    workspace.write('other/x', 'x\n');
    workspace.write('b', 'b\n');
    expect(workspace.decide(command, { mode: 'acceptEdits' }).kind).toBe('allow');
  });

  it('an earlier segment that plants a git layout makes the directory a later git segment runs in unknown', () => {
    const workspace = makeRealWorkspace();
    const script = path.join(workspace.base, 'hook.sh');
    const marker = path.join(workspace.base, 'fired');
    fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nprintf '\\0'\n`, { mode: 0o755 });
    workspace.initRepository();
    for (const directory of ['objects', 'refs']) workspace.mkdir(`evil/${directory}`);
    workspace.write('evil/HEAD', 'ref: refs/heads/main\n');
    workspace.write('evil/config', `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ..\n\tfsmonitor = ${script}\n`);
    const command = 'mv evil sub; cd sub && git status';
    workspace.runBash(command);
    expect(fs.existsSync(marker)).toBe(true);
    expect(workspace.decide(command, { mode: 'acceptEdits' }).kind).toBe('ask');
    expect(workspace.decide('touch x; git status', { mode: 'acceptEdits' }).kind).toBe('allow');
  });
});
