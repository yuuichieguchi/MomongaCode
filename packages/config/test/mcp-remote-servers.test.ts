import { describe, expect, it } from 'vitest';
import { loadMcpServers } from '@momonga/config';
import { distrusting, localSettingsPath, makeTree, mcpJsonPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const REMOTE = { type: 'http', url: 'https://mcp.example.com/mcp' } as const;

describe('remote MCP servers in .mcp.json', () => {
  it('is not read from a project the user has not trusted, whatever the file says', async () => {
    const tree = makeTree();
    writeJson(localSettingsPath(tree), { enableAllProjectMcpServers: true });
    writeJson(mcpJsonPath(tree), { mcpServers: { remote: REMOTE } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: distrusting(), env: {} });
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings.join('\n')).toContain('was not read');
  });

  it('waits for the same per-server approval as a stdio entry', async () => {
    const tree = makeTree();
    writeJson(mcpJsonPath(tree), { mcpServers: { remote: REMOTE, local: { command: 'srv' } } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval.map((entry) => [entry.name, entry.scope])).toEqual([
      ['remote', 'project'],
      ['local', 'project'],
    ]);
  });

  it('enables an approved remote entry in project scope with its oauth settings', async () => {
    const tree = makeTree();
    writeJson(localSettingsPath(tree), { enabledMcpjsonServers: ['remote'] });
    writeJson(mcpJsonPath(tree), { mcpServers: { remote: { ...REMOTE, oauth: { clientId: 'abc', scope: 'read', callbackPort: 33418 } } } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });
    expect(result.enabled).toEqual([{ name: 'remote', scope: 'project', config: { ...REMOTE, oauth: { clientId: 'abc', scope: 'read', callbackPort: 33418 } } }]);
  });

  it('refuses to expand a credential variable into a remote project entry', async () => {
    const tree = makeTree();
    writeJson(localSettingsPath(tree), { enableAllProjectMcpServers: true });
    writeJson(mcpJsonPath(tree), { mcpServers: { remote: { ...REMOTE, headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } } } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: { GITHUB_TOKEN: 'ghp_fake' } });
    expect(result.enabled).toEqual([]);
    expect(result.warnings.join('\n')).toContain('must not expand credential variable GITHUB_TOKEN');
  });

  it.each([
    ['callbackPort out of range', { ...REMOTE, oauth: { callbackPort: 70000 } }],
    ['unknown oauth key', { ...REMOTE, oauth: { clientSecret: 'x' } }],
    ['a stdio field on a remote entry', { ...REMOTE, command: 'srv' }],
  ])('skips an entry with %s and keeps the others', async (_label, entry) => {
    const tree = makeTree();
    writeJson(localSettingsPath(tree), { enableAllProjectMcpServers: true });
    writeJson(mcpJsonPath(tree), { mcpServers: { bad: entry, good: REMOTE } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });
    expect(result.enabled.map((server) => server.name)).toEqual(['good']);
    expect(result.warnings.join('\n')).toContain('skipped MCP server "bad"');
  });
});

describe('the deprecated HTTP+SSE transport', () => {
  it('is skipped in .mcp.json with a message naming the replacement', async () => {
    const tree = makeTree();
    writeJson(localSettingsPath(tree), { enableAllProjectMcpServers: true });
    writeJson(mcpJsonPath(tree), { mcpServers: { legacy: { type: 'sse', url: 'https://mcp.example.com/sse' }, good: REMOTE } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });
    expect(result.enabled.map((server) => server.name)).toEqual(['good']);
    expect(result.warnings.join('\n')).toContain('deprecated HTTP+SSE transport');
    expect(result.warnings.join('\n')).toContain('use type "http"');
  });

  it('is rejected in user settings with the same message', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcpServers: { legacy: { type: 'sse', url: 'https://mcp.example.com/sse' } } });
    await expect(loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} })).rejects.toThrow(/deprecated HTTP\+SSE transport/);
  });
});
