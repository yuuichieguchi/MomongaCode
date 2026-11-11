import { describe, expect, it } from 'vitest';
import { approvalDigestOf, loadMcpServers } from '@momonga/config';
import { makeTree, mcpJsonPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const signal = new AbortController().signal;

const FAKE_TOKEN = 'fake-token-for-tests';

const loadWith = (tree: ReturnType<typeof makeTree>, env: Record<string, string>, referenceEnv: Record<string, string>) =>
  loadMcpServers({ signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env, referenceEnv });

describe('an MCP credential is a reference', () => {
  it('passes a ${NAME} the person wrote in a user server from the environment the references read, while the stripped environment keeps it out', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      mcpServers: {
        github: { command: 'github-mcp', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
        remote: { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
      },
    });
    const stripped = { PATH: '/usr/bin' };
    const result = await loadWith(tree, stripped, { ...stripped, GITHUB_TOKEN: FAKE_TOKEN });
    expect(result.failed).toEqual([]);
    expect(result.enabled.map((server) => server.config)).toEqual([
      { command: 'github-mcp', env: { GITHUB_TOKEN: FAKE_TOKEN } },
      { type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: `Bearer ${FAKE_TOKEN}` } },
    ]);
    expect(stripped).toEqual({ PATH: '/usr/bin' });
  });

  it('still refuses a credential variable in a project server', async () => {
    const tree = makeTree();
    const github = { command: 'github-mcp', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } };
    writeJson(userSettingsPath(tree), { enabledMcpjsonServers: [{ name: 'github', digest: approvalDigestOf(github) }] });
    const file = writeJson(mcpJsonPath(tree), { mcpServers: { github } });
    const result = await loadWith(tree, {}, { GITHUB_TOKEN: FAKE_TOKEN });
    expect(result.enabled).toEqual([]);
    expect(result.warnings).toEqual([`${file}: skipped MCP server "github": must not expand credential variable GITHUB_TOKEN`]);
  });

  it('names a reference that is set nowhere, with the note of the two forms and no promise of a later store', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcpServers: { github: { command: 'github-mcp', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } } } });
    const result = await loadWith(tree, {}, {});
    expect(result.failed.map((failure) => failure.name)).toEqual(['github']);
    const note = result.warnings.find((warning) => warning.includes('secretEnv'));
    expect(note).toBeDefined();
    expect(note).toContain('${NAME}');
    expect(note).not.toMatch(/until|keychain/);
  });

  it('loads secretEnv in a user server and keeps only the names', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcpServers: { github: { command: 'github-mcp', secretEnv: { GITHUB_TOKEN: 'github.token' } } } });
    const result = await loadWith(tree, {}, {});
    expect(result.enabled).toEqual([{ name: 'github', scope: 'user', config: { command: 'github-mcp', secretEnv: { GITHUB_TOKEN: 'github.token' } } }]);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it.each([
    [{ GITHUB_TOKEN: 'bad name!' }, '/mcpServers/github'],
    [{ 'NOT-AN-ENV': 'github.token' }, '/mcpServers/github'],
  ])('refuses the secretEnv %j at load, naming the key', async (secretEnv, pointer) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcpServers: { github: { command: 'github-mcp', secretEnv } } });
    await expect(loadWith(tree, {}, {})).rejects.toThrow(pointer);
  });

  it('skips a project server that names a secret-store entry', async () => {
    const tree = makeTree();
    const github = { command: 'github-mcp', secretEnv: { GITHUB_TOKEN: 'github.token' } };
    writeJson(userSettingsPath(tree), { enabledMcpjsonServers: [{ name: 'github', digest: approvalDigestOf(github) }] });
    const file = writeJson(mcpJsonPath(tree), { mcpServers: { github } });
    const result = await loadWith(tree, {}, {});
    expect(result.enabled).toEqual([]);
    expect(result.warnings).toEqual([`${file}: skipped MCP server "github": secretEnv names an entry of the person's secret store and is only honored in user settings`]);
  });
});
