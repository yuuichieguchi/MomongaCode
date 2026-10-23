import { describe, expect, it } from 'vitest';
import { loadMcpServers, stripCredentialEnv } from '@momonga/config';
import { makeTree, mcpJsonPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const KEPT_IN_SNAPSHOT = ['SSH_AUTH_SOCK', 'GIT_AUTHOR_NAME'] as const;

describe('session keep-list names in a project .mcp.json', () => {
  it.each(KEPT_IN_SNAPSHOT)('refuses to expand ${%s}', async (variable) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { enableAllProjectMcpServers: true });
    writeJson(mcpJsonPath(tree), { mcpServers: { s: { command: 's', args: [`\${${variable}}`] } } });
    const failure = loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: { [variable]: 'v' } });
    await expect(failure).rejects.toThrow(variable);
    await expect(failure).rejects.toThrow('"s"');
  });

  it('keeps the same names in the session env snapshot', () => {
    const env = { SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_AUTHOR_NAME: 'A' };
    expect(stripCredentialEnv(env, [])).toEqual({ env, removed: [] });
  });
});
