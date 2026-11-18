import { describe, expect, it } from 'vitest';
import { approvalDigestOf, assertSessionMcpServers, loadMcpServers } from '@momonga/config';
import { makeTree, mcpJsonPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const signal = new AbortController().signal;

const loadWith = (tree: ReturnType<typeof makeTree>) => loadMcpServers({ signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {}, referenceEnv: {} });

describe('the per-server MCP call bounds: mcpServers.<name>.timeoutMs and mcpServers.<name>.idleTimeoutMs (host-bounds 4.5.2)', () => {
  it('keeps both keys of a user server, on a command server and on a URL server', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      mcpServers: {
        slow: { command: 'slow-mcp', timeoutMs: 7_200_000, idleTimeoutMs: 0 },
        remote: { type: 'http', url: 'https://mcp.example/mcp', timeoutMs: 1_000, idleTimeoutMs: 600_000 },
      },
    });
    const result = await loadWith(tree);
    expect(result.enabled.map((server) => server.config)).toEqual([
      { command: 'slow-mcp', timeoutMs: 7_200_000, idleTimeoutMs: 0 },
      { type: 'http', url: 'https://mcp.example/mcp', timeoutMs: 1_000, idleTimeoutMs: 600_000 },
    ]);
  });

  it.each([
    [{ timeoutMs: 0 }, '/mcpServers/slow'],
    [{ timeoutMs: 1.5 }, '/mcpServers/slow'],
    [{ idleTimeoutMs: -1 }, '/mcpServers/slow'],
    [{ idleTimeoutMs: '600000' }, '/mcpServers/slow'],
  ])('refuses %j in a user server at load, naming the server', async (bounds, pointer) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcpServers: { slow: { command: 'slow-mcp', ...bounds } } });
    await expect(loadWith(tree)).rejects.toThrow(pointer);
  });

  it.each([['timeoutMs'], ['idleTimeoutMs']])('skips a project server that sets %s, because the key is honored only in user settings', async (key) => {
    const tree = makeTree();
    const slow = { command: 'slow-mcp', [key]: 600_000 };
    writeJson(userSettingsPath(tree), { enabledMcpjsonServers: [{ name: 'slow', digest: approvalDigestOf(slow) }] });
    const file = writeJson(mcpJsonPath(tree), { mcpServers: { slow } });
    const result = await loadWith(tree);
    expect(result.enabled).toEqual([]);
    expect(result.warnings).toEqual([`${file}: skipped MCP server "slow": ${key} is only honored in user settings`]);
  });

  it.each([['timeoutMs'], ['idleTimeoutMs']])('refuses %s on a server passed with the session', (key) => {
    expect(() => assertSessionMcpServers({ slow: { command: 'slow-mcp', [key]: 600_000 } })).toThrow(`${key} is only honored in user settings`);
  });
});
