import { describe, expect, it } from 'vitest';
import { loadMcpServers, plainHttpWarningText } from '@momonga/config';
import { makeTree, trusting, userSettingsPath, writeJson } from './helpers.ts';

const ENV = {};

const loadUserServers = async (mcpServers: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { mcpServers });
  return loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: ENV, referenceEnv: ENV });
};

describe('a user-scope MCP server at a plain http address', () => {
  it('raises the plain-http notice at load, as a model connection does', async () => {
    const result = await loadUserServers({ remote: { type: 'http', url: 'http://192.168.1.20:8080/mcp' } });
    expect(result.enabled.map((entry) => entry.name)).toEqual(['remote']);
    expect(result.warnings).toEqual([plainHttpWarningText('remote')]);
  });

  it('does not raise it for http to this computer or for https to another one', async () => {
    const result = await loadUserServers({
      local: { type: 'http', url: 'http://127.0.0.1:8080/mcp' },
      secure: { type: 'http', url: 'https://mcp.example.com/mcp' },
    });
    expect(result.warnings).toEqual([]);
  });
});
