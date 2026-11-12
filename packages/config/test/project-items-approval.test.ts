import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_MANDATE_FILE, approvalDigestOf, approveProjectItems, hookGroupApprovalDigestOf, loadProjectMandate, loadSettings, loadUserSettings, pendingProjectItems, projectMandateState, settingsFileLock, systemFileLockPorts } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';
import { testKernelLock } from '@momonga/testkit';

const signal = new AbortController().signal;

const GROUP = { matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/check.sh' }] };
const DECLARED = { deny: ['Bash(curl:*)'], steps: 20 };

const writerOf = (tree: Tree) => ({ mechanism: testKernelLock(), lock: settingsFileLock(tree.home, { lock: testKernelLock() }), random: systemFileLockPorts.random, signal });

const approvals = async (tree: Tree) => (await loadUserSettings({ home: tree.home, signal })).settings.projectApprovals;

describe('the state of the folder mandate file, for the question and the editor', () => {
  it('says there is no file', async () => {
    const tree = makeTree();
    expect(await projectMandateState({ projectDir: tree.project, approvals: undefined, signal })).toEqual({ file: path.join(tree.project, PROJECT_MANDATE_FILE), found: false });
  });

  it('says a file never approved is new, a file approved before and changed is changed, and the approved one is approved', async () => {
    const tree = makeTree();
    const file = writeJson(path.join(tree.project, PROJECT_MANDATE_FILE), DECLARED);
    const digest = approvalDigestOf(DECLARED);
    expect(await projectMandateState({ projectDir: tree.project, approvals: undefined, signal })).toEqual({ file, found: true, document: DECLARED, digest, approval: 'new' });
    expect(await projectMandateState({ projectDir: tree.project, approvals: { [tree.project]: { mandate: 'f'.repeat(64) } }, signal })).toMatchObject({ approval: 'changed' });
    expect(await projectMandateState({ projectDir: tree.project, approvals: { [tree.project]: { mandate: digest } }, signal })).toMatchObject({ approval: 'approved' });
  });
});

describe('approveProjectItems: the writer of projectApprovals for the question', () => {
  it('records the approved hook groups and mandate of the folder, so the loader runs them', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { projectApprovals: { [tree.project]: { hooks: ['a'.repeat(64)] } } });
    writeJson(projectSettingsPath(tree), { hooks: { PreToolUse: [GROUP] } });
    writeJson(path.join(tree.project, PROJECT_MANDATE_FILE), DECLARED);
    const hook = hookGroupApprovalDigestOf('PreToolUse', GROUP);
    await approveProjectItems(tree.home, tree.project, [{ kind: 'hook', event: 'PreToolUse', group: GROUP, digest: hook }, { kind: 'mandate', document: DECLARED, digest: approvalDigestOf(DECLARED) }], writerOf(tree));
    expect(await approvals(tree)).toEqual({ [tree.project]: { hooks: ['a'.repeat(64), { digest: hook, event: 'PreToolUse', group: GROUP }], mandate: { digest: approvalDigestOf(DECLARED), document: DECLARED } } });
    const loaded = await loadSettings({ signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(loaded.settings.pendingHooks).toEqual([]);
    expect(loaded.settings.hooks).toEqual({ PreToolUse: [GROUP] });
    expect(await loadProjectMandate({ projectDir: tree.project, trusted: true, approvals: await approvals(tree), signal })).toEqual(DECLARED);
  });

  it('records a hook digest once', async () => {
    const tree = makeTree();
    const hook = hookGroupApprovalDigestOf('PreToolUse', GROUP);
    await approveProjectItems(tree.home, tree.project, [{ kind: 'hook', event: 'PreToolUse', group: GROUP, digest: hook }], writerOf(tree));
    await approveProjectItems(tree.home, tree.project, [{ kind: 'hook', event: 'PreToolUse', group: GROUP, digest: hook }], writerOf(tree));
    expect(await approvals(tree)).toEqual({ [tree.project]: { hooks: [{ digest: hook, event: 'PreToolUse', group: GROUP }] } });
  });
});

describe('the approved content is kept beside its digest, and a later change is shown against it', () => {
  const trusted = (tree: Tree) => ({ home: tree.home, projectDir: tree.project, trust: trusting(tree), signal });

  it('stores the approved hook group and mandate document with their digests, replacing a digest-only entry of the same item', async () => {
    const tree = makeTree();
    const hook = hookGroupApprovalDigestOf('PreToolUse', GROUP);
    writeJson(userSettingsPath(tree), { projectApprovals: { [tree.project]: { hooks: [hook] } } });
    await approveProjectItems(tree.home, tree.project, [{ kind: 'hook', event: 'PreToolUse', group: GROUP, digest: hook }, { kind: 'mandate', document: DECLARED, digest: approvalDigestOf(DECLARED) }], writerOf(tree));
    expect(await approvals(tree)).toEqual({ [tree.project]: { hooks: [{ digest: hook, event: 'PreToolUse', group: GROUP }], mandate: { digest: approvalDigestOf(DECLARED), document: DECLARED } } });
    writeJson(projectSettingsPath(tree), { hooks: { PreToolUse: [GROUP] } });
    expect((await loadSettings({ signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).settings.pendingHooks).toEqual([]);
  });

  it('says a hook group whose event and matcher were approved with other commands changed, with the approved group', async () => {
    const tree = makeTree();
    const changed = { ...GROUP, hooks: [{ type: 'command', command: './scripts/check.sh --fix' }] };
    await approveProjectItems(tree.home, tree.project, [{ kind: 'hook', event: 'PreToolUse', group: GROUP, digest: hookGroupApprovalDigestOf('PreToolUse', GROUP) }], writerOf(tree));
    writeJson(projectSettingsPath(tree), { hooks: { PreToolUse: [changed], PostToolUse: [GROUP] } });
    const pending = await pendingProjectItems(trusted(tree));
    expect(pending.items.map((item) => ({ kind: item.kind, change: item.change }))).toEqual([
      { kind: 'hook', change: { kind: 'changed', earlier: GROUP } },
      { kind: 'hook', change: { kind: 'new' } },
    ]);
  });

  it('says the earlier content is not recorded for a change under a digest-only approval', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { projectApprovals: { [tree.project]: { hooks: ['a'.repeat(64)], mandate: 'b'.repeat(64) } } });
    writeJson(projectSettingsPath(tree), { hooks: { PreToolUse: [GROUP] } });
    writeJson(path.join(tree.project, PROJECT_MANDATE_FILE), DECLARED);
    const pending = await pendingProjectItems(trusted(tree));
    expect(pending.items.map((item) => item.change)).toEqual([{ kind: 'not-recorded' }, { kind: 'not-recorded' }]);
  });

  it('says a mandate file changed since its approval, with the approved document', async () => {
    const tree = makeTree();
    await approveProjectItems(tree.home, tree.project, [{ kind: 'mandate', document: DECLARED, digest: approvalDigestOf(DECLARED) }], writerOf(tree));
    writeJson(path.join(tree.project, PROJECT_MANDATE_FILE), { ...DECLARED, steps: 50 });
    expect((await pendingProjectItems(trusted(tree))).items).toEqual([expect.objectContaining({ kind: 'mandate', change: { kind: 'changed', earlier: DECLARED } })]);
    await expect(loadProjectMandate({ projectDir: tree.project, trusted: true, approvals: await approvals(tree), signal })).rejects.toThrow('changed since it was approved');
  });
});
