import { describe, expect, it } from 'vitest';
import { approvalDigestOf, loadMcpServers } from '@momonga/config';
import { localSettingsPath, makeTree, mcpJsonPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const signal = new AbortController().signal;

const DOCS = { command: 'npx', args: ['docs-server', '--port', '${DOCS_PORT:-4000}'], env: { MODE: 'read' } };

const loadWith = async (tree: ReturnType<typeof makeTree>, env: Record<string, string> = {}) =>
  loadMcpServers({ signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env, referenceEnv: env });

const approve = (tree: ReturnType<typeof makeTree>, config: unknown): void => {
  writeJson(userSettingsPath(tree), { enabledMcpjsonServers: [{ name: 'docs', digest: approvalDigestOf(config) }] });
};

describe('an approval of a project MCP server names the server it approved', () => {
  it('starts the server whose definition is the approved one', async () => {
    const tree = makeTree();
    writeJson(mcpJsonPath(tree), { mcpServers: { docs: DOCS } });
    approve(tree, DOCS);
    const result = await loadWith(tree);
    expect(result.enabled.map((server) => server.name)).toEqual(['docs']);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['command', { ...DOCS, command: 'curl' }],
    ['args', { ...DOCS, args: ['docs-server', '--port', '4001'] }],
    ['env', { ...DOCS, env: { MODE: 'write' } }],
  ])('does not start the server when its %s changed, reports it, and starts it after it is approved again', async (_field, changed) => {
    const tree = makeTree();
    approve(tree, DOCS);
    const file = writeJson(mcpJsonPath(tree), { mcpServers: { docs: changed } });
    const result = await loadWith(tree);
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval).toEqual([{ name: 'docs', scope: 'project', config: changed, digest: approvalDigestOf(changed), changed: true }]);
    expect(result.warnings).toEqual([`${file}: MCP server "docs" changed since it was approved; it is not started until it is approved again`]);
    approve(tree, changed);
    expect((await loadWith(tree)).enabled.map((server) => server.name)).toEqual(['docs']);
  });

  it('takes the digest of the definition as written, so a changed variable value is not a changed server', async () => {
    const tree = makeTree();
    writeJson(mcpJsonPath(tree), { mcpServers: { docs: DOCS } });
    approve(tree, DOCS);
    const first = await loadWith(tree, { DOCS_PORT: '5000' });
    const second = await loadWith(tree, { DOCS_PORT: '6000' });
    expect(first.enabled.map((server) => server.config)).toEqual([{ ...DOCS, args: ['docs-server', '--port', '5000'] }]);
    expect(second.enabled.map((server) => server.config)).toEqual([{ ...DOCS, args: ['docs-server', '--port', '6000'] }]);
  });

  it('carries the digest on a server never approved, unchanged', async () => {
    const tree = makeTree();
    writeJson(mcpJsonPath(tree), { mcpServers: { docs: DOCS } });
    const result = await loadWith(tree);
    expect(result.pendingApproval).toEqual([{ name: 'docs', scope: 'project', config: DOCS, digest: approvalDigestOf(DOCS), changed: false }]);
    expect(result.warnings).toEqual([]);
  });

  it('asks again for a server approved by name alone, which names no definition', async () => {
    const tree = makeTree();
    writeJson(localSettingsPath(tree), { enabledMcpjsonServers: ['docs'] });
    const file = writeJson(mcpJsonPath(tree), { mcpServers: { docs: DOCS } });
    const result = await loadWith(tree);
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval.map((server) => [server.name, server.changed])).toEqual([['docs', true]]);
    expect(result.warnings).toEqual([`${file}: MCP server "docs" changed since it was approved; it is not started until it is approved again`]);
  });

  it('refuses an approval whose digest is not a digest', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { enabledMcpjsonServers: [{ name: 'docs', digest: 'abc' }] });
    writeJson(mcpJsonPath(tree), { mcpServers: { docs: DOCS } });
    await expect(loadWith(tree)).rejects.toThrow('/enabledMcpjsonServers/0');
  });
});
