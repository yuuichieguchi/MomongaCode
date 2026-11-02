import { describe, expect, it } from 'vitest';
import { assertSessionMcpServers, loadMcpServers } from '@momonga/config';
import { distrusting, localSettingsPath, makeTree, mcpJsonPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const SESSION_STDIO = { type: 'stdio', command: 'editor-server', args: ['--stdio'], env: { TOKEN: '${NOT_EXPANDED}' } };
const SESSION_HTTP = { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer literal' } };

describe('loadMcpServers with session servers', () => {
  it('enables session servers as they were given, without expanding ${VAR}', async () => {
    const tree = makeTree();
    const result = await loadMcpServers({
      home: tree.home,
      projectDir: tree.project,
      trust: trusting(tree),
      env: { NOT_EXPANDED: 'secret' },
      sessionServers: { editor: SESSION_STDIO, docs: SESSION_HTTP },
    });

    expect(result.enabled).toEqual([
      { name: 'editor', scope: 'session', config: SESSION_STDIO },
      { name: 'docs', scope: 'session', config: SESSION_HTTP },
    ]);
    expect(result.failed).toEqual([]);
  });

  it('enables session servers in a folder that is not trusted', async () => {
    const tree = makeTree();
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: distrusting(), env: {}, sessionServers: { editor: SESSION_STDIO } });

    expect(result.enabled.map((entry) => entry.scope)).toEqual(['session']);
  });

  it('lists user servers first, then session servers, then approved project servers', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcpServers: { mine: { command: 'user-server' } } });
    writeJson(localSettingsPath(tree), { enableAllProjectMcpServers: true });
    writeJson(mcpJsonPath(tree), { mcpServers: { shared: { command: 'project-server' } } });
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {}, sessionServers: { editor: SESSION_STDIO } });

    expect(result.enabled.map((entry) => [entry.name, entry.scope])).toEqual([
      ['mine', 'user'],
      ['editor', 'session'],
      ['shared', 'project'],
    ]);
  });

  it('refuses a session server that reuses the name of a user server and keeps the user server', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcpServers: { editor: { command: 'user-server' } } });
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {}, sessionServers: { editor: SESSION_STDIO, other: SESSION_HTTP } });

    expect(result.enabled.map((entry) => [entry.name, entry.scope])).toEqual([
      ['editor', 'user'],
      ['other', 'session'],
    ]);
    expect(result.failed).toEqual([{ name: 'editor', reason: 'the user settings already define an MCP server named "editor"' }]);
  });

  it('skips the project servers with a warning when a session server uses a project server name', async () => {
    const tree = makeTree();
    writeJson(localSettingsPath(tree), { enableAllProjectMcpServers: true });
    writeJson(mcpJsonPath(tree), { mcpServers: { editor: { command: 'project-server' } } });
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {}, sessionServers: { editor: SESSION_STDIO } });

    expect(result.enabled.map((entry) => [entry.name, entry.scope])).toEqual([['editor', 'session']]);
    expect(result.warnings.join('\n')).toContain('"editor"');
  });

  it('throws a config error for a session server that does not validate', async () => {
    const tree = makeTree();

    await expect(
      loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {}, sessionServers: { editor: { nonsense: true } } }),
    ).rejects.toThrow(/invalid MCP server "editor"/);
  });
});

describe('assertSessionMcpServers', () => {
  it('returns the servers when every name and config is valid', () => {
    expect(assertSessionMcpServers({ editor: SESSION_STDIO, docs: SESSION_HTTP })).toEqual({ editor: SESSION_STDIO, docs: SESSION_HTTP });
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['a server named with a double underscore', { 'a__b': SESSION_STDIO }],
    ['a server without a command or url', { editor: {} }],
    ['a legacy sse server', { editor: { type: 'sse', url: 'https://example.com/sse' } }],
  ])('rejects %s', (_label, value) => {
    expect(() => assertSessionMcpServers(value)).toThrow();
  });
});
