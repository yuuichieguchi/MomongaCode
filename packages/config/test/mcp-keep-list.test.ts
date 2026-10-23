import { describe, expect, it } from 'vitest';
import { loadMcpServers, stripCredentialEnv } from '@momonga/config';
import { makeTree, mcpJsonPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const KEPT_IN_SNAPSHOT = ['SSH_AUTH_SOCK', 'GIT_AUTHOR_NAME'] as const;

describe('session keep-list names in a project .mcp.json', () => {
  it.each(KEPT_IN_SNAPSHOT)('skips only the server that references ${%s}', async (variable) => {
    const tree = makeTree();
    const secret = `secret-value-of-${variable}`;
    writeJson(userSettingsPath(tree), { enableAllProjectMcpServers: true });
    writeJson(mcpJsonPath(tree), { mcpServers: { s: { command: 's', args: [`\${${variable}}`] } } });
    const result = await loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: { [variable]: secret } });
    const names = (entries: readonly unknown[]): unknown[] => entries.map((entry) => (entry as { name: unknown }).name);
    expect(names(result.enabled)).not.toContain('s');
    expect(names(result.pendingApproval)).not.toContain('s');
    expect(names(result.failed)).not.toContain('s');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('"s"');
    expect(result.warnings[0]).toContain(variable);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('keeps the same names in the session env snapshot', () => {
    const env = { SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_AUTHOR_NAME: 'A' };
    expect(stripCredentialEnv(env, [])).toEqual({ env, removed: [] });
  });
});
