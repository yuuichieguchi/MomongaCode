import { describe, expect, it } from 'vitest';
import { hookGroupApprovalDigestOf, loadSettings } from '@momonga/config';
import { distrusting, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const signal = new AbortController().signal;

const GROUP = { matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/check.sh' }] };

const loadFor = (tree: ReturnType<typeof makeTree>, trust = trusting(tree)) => loadSettings({ env: process.env, signal, home: tree.home, projectDir: tree.project, cli: {}, trust });

describe('a hook group of the project settings runs only as approved', () => {
  it('holds back a group never approved, with its digest, and says it does not run', async () => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { hooks: { PreToolUse: [GROUP] } });
    const result = await loadFor(tree);
    expect(result.settings.hooks).toEqual({});
    expect(result.settings.pendingHooks).toEqual([{ event: 'PreToolUse', group: GROUP, digest: hookGroupApprovalDigestOf('PreToolUse', GROUP), source: file }]);
    expect(result.warnings).toEqual([`${file}: a PreToolUse hook group is not approved for this folder, or changed since it was approved; it does not run until it is approved`]);
  });

  it('runs a group whose digest the user settings approved for the canonical folder', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { hooks: { PreToolUse: [GROUP] } });
    writeJson(userSettingsPath(tree), { projectApprovals: { [tree.project]: { hooks: [hookGroupApprovalDigestOf('PreToolUse', GROUP)] } } });
    const result = await loadFor(tree);
    expect(result.warnings).toEqual([]);
    expect(result.settings.hooks).toEqual({ PreToolUse: [GROUP] });
    expect(result.settings.pendingHooks).toEqual([]);
  });

  it('holds back a group whose command changed after the approval', async () => {
    const tree = makeTree();
    const changed = { ...GROUP, hooks: [{ type: 'command', command: './scripts/check.sh --fix' }] };
    writeJson(projectSettingsPath(tree), { hooks: { PreToolUse: [GROUP, changed] } });
    writeJson(userSettingsPath(tree), { projectApprovals: { [tree.project]: { hooks: [hookGroupApprovalDigestOf('PreToolUse', GROUP)] } } });
    const result = await loadFor(tree);
    expect(result.settings.hooks).toEqual({ PreToolUse: [GROUP] });
    expect(result.settings.pendingHooks.map((pending) => pending.group)).toEqual([changed]);
  });

  it('does not take the approval of the same group under another event', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { hooks: { PostToolUse: [GROUP] } });
    writeJson(userSettingsPath(tree), { projectApprovals: { [tree.project]: { hooks: [hookGroupApprovalDigestOf('PreToolUse', GROUP)] } } });
    expect((await loadFor(tree)).settings.hooks).toEqual({});
  });

  it('runs the user settings hooks with no approval', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { hooks: { PreToolUse: [GROUP] } });
    const result = await loadFor(tree);
    expect(result.settings.hooks).toEqual({ PreToolUse: [GROUP] });
    expect(result.settings.pendingHooks).toEqual([]);
  });

  it('discards projectApprovals in the project settings with a warning', async () => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { hooks: { PreToolUse: [GROUP] }, projectApprovals: { [tree.project]: { hooks: [hookGroupApprovalDigestOf('PreToolUse', GROUP)] } } });
    const result = await loadFor(tree);
    expect(result.warnings).toContain(`${file}: projectApprovals is only honored in user settings; discarded`);
    expect(result.settings.hooks).toEqual({});
  });

  it('reads no project hook in a folder that is not trusted', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { hooks: { PreToolUse: [GROUP] } });
    expect((await loadFor(tree, distrusting())).settings.pendingHooks).toEqual([]);
  });
});
