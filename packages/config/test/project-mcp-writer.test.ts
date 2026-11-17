import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, approvalDigestOf, loadMcpServers, pendingProjectItems, settingsWriterPorts, writeProjectMcpServer } from '@momonga/config';
import { testKernelLock } from '@momonga/testkit';
import { distrusting, makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const signal = new AbortController().signal;
const DOCS = { type: 'stdio', command: 'npx', args: ['docs-server'] };

const optionsOf = (tree: Tree, trust = trusting(tree)) => ({ env: {}, home: tree.home, trust, ...settingsWriterPorts(tree.home, { lock: testKernelLock(), signal }) });
const mcpFile = (tree: Tree): string => path.join(tree.project, '.mcp.json');

describe('writeProjectMcpServer: the one writer of the project .mcp.json', () => {
  it('writes the server into .mcp.json beside the servers already there, and approves the written content so it is not asked about again', async () => {
    const tree = makeTree();
    writeJson(mcpFile(tree), { mcpServers: { wiki: { command: 'wiki' } } });
    await writeProjectMcpServer(tree.project, 'docs', DOCS, optionsOf(tree));
    expect(JSON.parse(fs.readFileSync(mcpFile(tree), 'utf8'))).toEqual({ mcpServers: { wiki: { command: 'wiki' }, docs: DOCS } });
    const loaded = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {}, referenceEnv: {}, signal });
    expect(loaded.enabled.map((server) => server.name)).toEqual(['docs']);
    const pending = await pendingProjectItems({ env: {}, home: tree.home, projectDir: tree.project, trust: trusting(tree), agents: async () => [], signal });
    expect(pending.items.map((item) => (item.kind === 'mcp' ? item.name : item.kind))).toEqual(['wiki']);
  });

  it('refuses a folder that is not trusted, a secretEnv, a name the user settings hold, and an invalid server, writing nothing', async () => {
    const tree = makeTree();
    await expect(writeProjectMcpServer(tree.project, 'docs', DOCS, optionsOf(tree, distrusting()))).rejects.toThrow(ConfigError);
    await expect(writeProjectMcpServer(tree.project, 'docs', { ...DOCS, secretEnv: { TOKEN: 'docs-token' } }, optionsOf(tree))).rejects.toThrow(/only honored in user settings/);
    writeJson(userSettingsPath(tree), { mcpServers: { docs: DOCS } });
    await expect(writeProjectMcpServer(tree.project, 'docs', DOCS, optionsOf(tree))).rejects.toThrow(/already define an MCP server named "docs"/);
    await expect(writeProjectMcpServer(tree.project, 'other', { type: 'stdio' }, optionsOf(tree))).rejects.toThrow(ConfigError);
    expect(fs.existsSync(mcpFile(tree))).toBe(false);
  });

  it('refuses a .mcp.json that is a symbolic link out of the folder', async () => {
    const tree = makeTree();
    const outside = path.join(path.dirname(tree.project), 'outside.json');
    writeJson(outside, { mcpServers: {} });
    fs.symlinkSync(outside, mcpFile(tree));
    await expect(writeProjectMcpServer(tree.project, 'docs', DOCS, optionsOf(tree))).rejects.toThrow();
    expect(JSON.parse(fs.readFileSync(outside, 'utf8'))).toEqual({ mcpServers: {} });
  });
});
