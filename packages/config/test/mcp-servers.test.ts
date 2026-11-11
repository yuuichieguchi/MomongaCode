import { describe, expect, it } from 'vitest';
import { approvalDigestOf, loadMcpServers } from '@momonga/config';
import {
  distrusting,
  localSettingsPath,
  makeTree,
  mcpJsonPath,
  projectSettingsPath,
  trusting,
  userSettingsPath,
  writeJson,
  writeText,
} from './helpers.ts';

const ENV = { HOME_BIN: '/opt/bin', TOKEN_VALUE: 'abc', PLAIN_VALUE: 'abc', PORT: '9000' };

describe('loadMcpServers', () => {
  it('expands ${VAR} and ${VAR:-default} in command, args, env, url and headers', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      mcpServers: {
        remote: { type: 'http', url: 'http://127.0.0.1:${PORT}/mcp', headers: { Authorization: 'Bearer ${TOKEN_VALUE}' } },
      },
    });
    const tools = {
      command: '${HOME_BIN}/server',
      args: ['--level', '${LEVEL:-info}', '--port=${PORT}'],
      env: { KEY: '${PLAIN_VALUE}', MODE: '${MODE:-dev}' },
      cwd: '${CWD:-.}',
    };
    writeJson(localSettingsPath(tree), { enabledMcpjsonServers: [{ name: 'tools', digest: approvalDigestOf(tools) }] });
    writeJson(mcpJsonPath(tree), { mcpServers: { tools } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: ENV, referenceEnv: ENV });
    expect(result.enabled).toEqual([
      {
        name: 'remote',
        scope: 'user',
        config: { type: 'http', url: 'http://127.0.0.1:9000/mcp', headers: { Authorization: 'Bearer abc' } },
      },
      {
        name: 'tools',
        scope: 'project',
        config: { command: '/opt/bin/server', args: ['--level', 'info', '--port=9000'], env: { KEY: 'abc', MODE: 'dev' }, cwd: '.' },
      },
    ]);
    expect(result.pendingApproval).toEqual([]);
  });

  it('reports a project server with an unset ${VAR} as failed instead of throwing', async () => {
    const tree = makeTree();
    writeJson(localSettingsPath(tree), { enableAllProjectMcpServers: true });
    writeJson(mcpJsonPath(tree), {
      mcpServers: { db: { command: 'db-mcp', args: ['${DB_HOST}'] }, ok: { command: 'ok-mcp', args: ['${PORT}'] } },
    });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: ENV, referenceEnv: ENV });
    expect(result.enabled).toEqual([{ name: 'ok', scope: 'project', config: { command: 'ok-mcp', args: ['9000'] } }]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe('db');
    expect(result.failed[0]?.reason).toContain('DB_HOST');
  });

  it('reports a user server with an unset ${VAR} as failed and keeps the other user servers', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      mcpServers: {
        gh: { command: 'gh-mcp', env: { T: '${GITHUB_TOKEN}' } },
        files: { command: '${HOME_BIN}/files' },
      },
    });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: ENV, referenceEnv: ENV });
    expect(result.enabled).toEqual([{ name: 'files', scope: 'user', config: { command: '/opt/bin/files' } }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe('gh');
    expect(result.failed[0]?.reason).toContain('GITHUB_TOKEN');
  });

  it('reports no failures when every variable is set', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcpServers: { files: { command: '${HOME_BIN}/files' } } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: ENV, referenceEnv: ENV });
    expect(result.failed).toEqual([]);
  });

  it('skips a project server with an invalid name and warns naming it', async () => {
    const tree = makeTree();
    writeJson(mcpJsonPath(tree), { mcpServers: { 'bad name!': { command: 'x' } } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: ENV, referenceEnv: ENV });
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings.filter((w) => w.includes('bad name!'))).toHaveLength(1);
  });

  it('warns about malformed .mcp.json with file and line', async () => {
    const tree = makeTree();
    const file = writeText(mcpJsonPath(tree), '{\n  "mcpServers": {\n    "a": }\n}\n');
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: ENV, referenceEnv: ENV });
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings.filter((w) => w.includes(file) && /line 3/.test(w))).toHaveLength(1);
  });

  it('puts project servers in pendingApproval unless enabled by user or local settings', async () => {
    const tree = makeTree();
    const approved = (name: string) => ({ name, digest: approvalDigestOf({ command: name }) });
    writeJson(userSettingsPath(tree), { enabledMcpjsonServers: [approved('a')] });
    writeJson(projectSettingsPath(tree), { enabledMcpjsonServers: [approved('b')], enableAllProjectMcpServers: true });
    writeJson(localSettingsPath(tree), { enabledMcpjsonServers: [approved('c')], disabledMcpjsonServers: ['a'] });
    writeJson(mcpJsonPath(tree), {
      mcpServers: { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' }, d: { command: 'd' } },
    });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: ENV, referenceEnv: ENV });
    expect(result.enabled.map((s) => s.name)).toEqual(['c']);
    expect(result.pendingApproval.map((s) => s.name)).toEqual(['a', 'b', 'd']);
  });

  it('enables all project servers with enableAllProjectMcpServers from user settings except disabled ones', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { enableAllProjectMcpServers: true, disabledMcpjsonServers: ['x'] });
    writeJson(mcpJsonPath(tree), { mcpServers: { x: { command: 'x' }, y: { command: 'y' } } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: ENV, referenceEnv: ENV });
    expect(result.enabled.map((s) => s.name)).toEqual(['y']);
    expect(result.pendingApproval.map((s) => s.name)).toEqual(['x']);
  });

  it('does not read .mcp.json in an untrusted project and warns naming it', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      enableAllProjectMcpServers: true,
      mcpServers: { mine: { command: 'mine' } },
    });
    const file = writeJson(mcpJsonPath(tree), { mcpServers: { evil: { command: 'evil' } } });
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: distrusting(), env: ENV, referenceEnv: ENV });
    expect(result.enabled.map((s) => s.name)).toEqual(['mine']);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings.some((w) => w.includes(file))).toBe(true);
  });
});
