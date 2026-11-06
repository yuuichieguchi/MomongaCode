import { describe, expect, it } from 'vitest';
import { loadMcpServers, stripCredentialEnv } from '@momonga/config';
import { makeTree, mcpJsonPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const names = (entries: readonly unknown[]): unknown[] => entries.map((entry) => (entry as { name: unknown }).name);

const load = async (variable: string, secret: string) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { enableAllProjectMcpServers: true });
  writeJson(mcpJsonPath(tree), { mcpServers: { s: { command: 's', args: [`\${${variable}}`] } } });
  return loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: { [variable]: secret } });
};

describe('the security vocabulary decides which variables a project .mcp.json may reference', () => {
  it('skips only the server that references a variable named with a weak whole word', async () => {
    const secret = 'secret-value-of-SSH_AUTH_SOCK';
    const result = await load('SSH_AUTH_SOCK', secret);
    expect(names(result.enabled)).not.toContain('s');
    expect(names(result.pendingApproval)).not.toContain('s');
    expect(names(result.failed)).not.toContain('s');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('"s"');
    expect(result.warnings[0]).toContain('SSH_AUTH_SOCK');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('lets a project server reference a variable whose name has no word of the vocabulary', async () => {
    const result = await load('GIT_AUTHOR_NAME', 'A');
    expect(names(result.enabled)).toContain('s');
    expect(result.warnings).toEqual([]);
  });

  it('withholds the same names from the session env snapshot', () => {
    const env = { SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_AUTHOR_NAME: 'A' };
    expect(stripCredentialEnv(env, [])).toEqual({ env: { GIT_AUTHOR_NAME: 'A' }, removed: ['SSH_AUTH_SOCK'] });
  });
});
