import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_MANDATE_FILE, approvalDigestOf, approveProjectItems, hookGroupApprovalDigestOf, loadProjectMandate, loadSettings, loadUserSettings, projectMandateState, settingsFileLock, systemFileLockPorts } from '@momonga/config';
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
    await approveProjectItems(tree.home, tree.project, { hooks: [hook], mandate: approvalDigestOf(DECLARED) }, writerOf(tree));
    expect(await approvals(tree)).toEqual({ [tree.project]: { hooks: ['a'.repeat(64), hook], mandate: approvalDigestOf(DECLARED) } });
    const loaded = await loadSettings({ signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(loaded.settings.pendingHooks).toEqual([]);
    expect(loaded.settings.hooks).toEqual({ PreToolUse: [GROUP] });
    expect(await loadProjectMandate({ projectDir: tree.project, trusted: true, approvals: await approvals(tree), signal })).toEqual(DECLARED);
  });

  it('records a hook digest once', async () => {
    const tree = makeTree();
    const hook = hookGroupApprovalDigestOf('PreToolUse', GROUP);
    await approveProjectItems(tree.home, tree.project, { hooks: [hook] }, writerOf(tree));
    await approveProjectItems(tree.home, tree.project, { hooks: [hook] }, writerOf(tree));
    expect(await approvals(tree)).toEqual({ [tree.project]: { hooks: [hook] } });
  });
});
