import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_MANDATE_FILE, approvalDigestOf, approveProjectItems, hookGroupApprovalDigestOf, loadMcpServers, projectAgentDigestOf, loadProjectMandate, loadSettings, loadUserSettings, pendingProjectItems, projectMandateState, settingsFileLock, systemFileLockPorts } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';
import type { ProjectAgentFile } from '@momonga/config';
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
  const trusted = (tree: Tree) => ({ home: tree.home, projectDir: tree.project, trust: trusting(tree), agents: async () => [], signal });

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

describe('an MCP server of .mcp.json is asked about by the same mechanism', () => {
  const DOCS = { command: 'npx', args: ['docs-server'] };
  const mcpFile = (tree: Tree): string => path.join(tree.project, '.mcp.json');
  const trusted = (tree: Tree) => ({ home: tree.home, projectDir: tree.project, trust: trusting(tree), agents: async () => [], signal });
  const servers = async (tree: Tree) => loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {}, referenceEnv: {}, signal });

  it('lists a server never approved as new, and after the approval keeps its config and starts it', async () => {
    const tree = makeTree();
    writeJson(mcpFile(tree), { mcpServers: { docs: DOCS } });
    const [item] = (await pendingProjectItems(trusted(tree))).items;
    expect(item).toEqual({ kind: 'mcp', name: 'docs', config: DOCS, digest: approvalDigestOf(DOCS), source: mcpFile(tree), change: { kind: 'new' } });
    await approveProjectItems(tree.home, tree.project, [{ kind: 'mcp', name: 'docs', config: DOCS, digest: approvalDigestOf(DOCS) }], writerOf(tree));
    expect((await loadUserSettings({ home: tree.home, signal })).settings.enabledMcpjsonServers).toEqual([{ name: 'docs', digest: approvalDigestOf(DOCS), config: DOCS }]);
    expect((await servers(tree)).enabled.map((server) => server.name)).toEqual(['docs']);
    expect((await pendingProjectItems(trusted(tree))).items).toEqual([]);
  });

  it('says a server changed since its approval with the approved config, and not recorded under a name-only approval', async () => {
    const tree = makeTree();
    await approveProjectItems(tree.home, tree.project, [{ kind: 'mcp', name: 'docs', config: DOCS, digest: approvalDigestOf(DOCS) }], writerOf(tree));
    writeJson(mcpFile(tree), { mcpServers: { docs: { ...DOCS, args: ['docs-server', '--write'] } } });
    expect((await pendingProjectItems(trusted(tree))).items.map((item) => item.change)).toEqual([{ kind: 'changed', earlier: DOCS }]);
    writeJson(userSettingsPath(tree), { enabledMcpjsonServers: ['docs'] });
    expect((await pendingProjectItems(trusted(tree))).items.map((item) => item.change)).toEqual([{ kind: 'not-recorded' }]);
  });

  it('does not ask about a server the person disabled', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { disabledMcpjsonServers: ['docs'] });
    writeJson(mcpFile(tree), { mcpServers: { docs: DOCS } });
    expect((await pendingProjectItems(trusted(tree))).items).toEqual([]);
  });
});

describe('a project agent, which runs with tools, is asked about by the same mechanism', () => {
  const TEXT = '---\nname: reviewer\ndescription: Reviews\ntools: Read, Bash\n---\nReview the change.\n';
  const CHANGED = '---\nname: reviewer\ndescription: Reviews\ntools: Read, Bash, Write\n---\nReview the change.\n';
  const sourceOf = (tree: Tree): string => path.join(tree.project, '.momonga', 'agents', 'reviewer.md');
  const listing = (tree: Tree, text: string) => ({ home: tree.home, projectDir: tree.project, trust: trusting(tree), agents: async (): Promise<ProjectAgentFile[]> => [{ name: 'reviewer', text, source: sourceOf(tree) }], signal });

  it('lists a project agent never approved as new with its whole file, and stores the file on approval so it is no longer listed', async () => {
    const tree = makeTree();
    const digest = projectAgentDigestOf('reviewer', TEXT);
    expect((await pendingProjectItems(listing(tree, TEXT))).items).toEqual([{ kind: 'agent', name: 'reviewer', text: TEXT, digest, source: sourceOf(tree), change: { kind: 'new' } }]);
    await approveProjectItems(tree.home, tree.project, [{ kind: 'agent', name: 'reviewer', text: TEXT, digest }], writerOf(tree));
    expect(await approvals(tree)).toEqual({ [tree.project]: { agents: [{ name: 'reviewer', digest, text: TEXT }] } });
    expect((await pendingProjectItems(listing(tree, TEXT))).items).toEqual([]);
  });

  it('says a project agent changed since its approval, with the approved file, and replaces the approval of that name on a new approval', async () => {
    const tree = makeTree();
    await approveProjectItems(tree.home, tree.project, [{ kind: 'agent', name: 'reviewer', text: TEXT, digest: projectAgentDigestOf('reviewer', TEXT) }], writerOf(tree));
    expect((await pendingProjectItems(listing(tree, CHANGED))).items.map((item) => item.change)).toEqual([{ kind: 'changed', earlier: TEXT }]);
    const digest = projectAgentDigestOf('reviewer', CHANGED);
    await approveProjectItems(tree.home, tree.project, [{ kind: 'agent', name: 'reviewer', text: CHANGED, digest }], writerOf(tree));
    expect(await approvals(tree)).toEqual({ [tree.project]: { agents: [{ name: 'reviewer', digest, text: CHANGED }] } });
  });

  it('lists no agent of a folder that is not trusted', async () => {
    const tree = makeTree();
    expect((await pendingProjectItems({ ...listing(tree, TEXT), trust: { isTrusted: async () => false } })).items).toEqual([]);
  });
});
