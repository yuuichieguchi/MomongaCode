import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadMcpServers } from '@momonga/config';
import { makeDir, makeTree, mcpJsonPath, trusting, userSettingsPath, writeJson, writeText } from './helpers.ts';
import type { Tree } from './helpers.ts';

const load = (tree: Tree) => loadMcpServers({ home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });

const approveAll = (tree: Tree, servers: Record<string, unknown> = {}): void => {
  writeJson(userSettingsPath(tree), { enableAllProjectMcpServers: true, mcpServers: servers });
};

describe('loadMcpServers project file errors', () => {
  it('skips the project servers of a malformed .mcp.json with a warning naming the file', async () => {
    const tree = makeTree();
    approveAll(tree, { mine: { command: 'mine' } });
    const file = writeText(mcpJsonPath(tree), '{\n  "mcpServers": {\n    "a": }\n}\n');
    const result = await load(tree);
    expect(result.enabled.map((s) => [s.name, s.scope])).toEqual([['mine', 'user']]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.warnings.filter((w) => w.includes(file))).toHaveLength(1);
  });

  it('skips every project server when one name clashes with a user server', async () => {
    const tree = makeTree();
    approveAll(tree, { shared: { command: 'user-shared' } });
    const file = writeJson(mcpJsonPath(tree), { mcpServers: { shared: { command: 'project-shared' }, extra: { command: 'extra' } } });
    const result = await load(tree);
    expect(result.enabled.map((s) => [s.name, s.scope, s.config])).toEqual([['shared', 'user', { command: 'user-shared' }]]);
    expect(result.pendingApproval).toEqual([]);
    const warnings = result.warnings.filter((w) => w.includes(file));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('shared');
  });

  it('skips the project servers when .mcp.json is a symlink outside the project', async () => {
    const tree = makeTree();
    approveAll(tree);
    const outside = writeJson(path.join(makeDir(), 'm.json'), { mcpServers: { a: { command: 'a' } } });
    fs.symlinkSync(outside, mcpJsonPath(tree));
    const result = await load(tree);
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings.some((w) => w.includes(mcpJsonPath(tree)))).toBe(true);
  });
});

describe('loadMcpServers single invalid project server', () => {
  it('skips a server with an invalid name and keeps the others', async () => {
    const tree = makeTree();
    approveAll(tree);
    const file = writeJson(mcpJsonPath(tree), { mcpServers: { 'bad name!': { command: 'x' }, good: { command: 'good' } } });
    const result = await load(tree);
    expect(result.enabled.map((s) => [s.name, s.scope])).toEqual([['good', 'project']]);
    const warnings = result.warnings.filter((w) => w.includes('bad name!'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
  });

  it('skips a server that violates the schema and keeps the others', async () => {
    const tree = makeTree();
    approveAll(tree);
    const file = writeJson(mcpJsonPath(tree), { mcpServers: { broken: { command: 123 }, good: { command: 'good' } } });
    const result = await load(tree);
    expect(result.enabled.map((s) => s.name)).toEqual(['good']);
    const warnings = result.warnings.filter((w) => w.includes('broken'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
  });

  it('skips an unapproved invalid server without dropping the pending ones', async () => {
    const tree = makeTree();
    writeJson(mcpJsonPath(tree), { mcpServers: { broken: { url: 'http://x' }, waiting: { command: 'waiting' } } });
    const result = await load(tree);
    expect(result.pendingApproval.map((s) => s.name)).toEqual(['waiting']);
    expect(result.warnings.filter((w) => w.includes('broken'))).toHaveLength(1);
  });
});

describe('loadMcpServers user-scope errors', () => {
  it('throws ConfigError for an invalid user server name', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { mcpServers: { 'bad name!': { command: 'x' } } });
    const failure = load(tree);
    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toThrow('bad name!');
  });

  it('throws ConfigError for a user server schema violation', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { mcpServers: { broken: { command: 123 } } });
    const failure = load(tree);
    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toThrow(file);
  });

  it('throws ConfigError for malformed user settings', async () => {
    const tree = makeTree();
    const file = writeText(userSettingsPath(tree), '{\n  "mcpServers": {\n    "a": }\n}\n');
    const failure = load(tree);
    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toThrow(file);
  });
});

describe('loadMcpServers non-object project server value', () => {
  it.each([
    ['1', 1],
    ['null', null],
    ['"str"', 'str'],
    ['[]', []],
  ])('skips only the server whose value is %s', async (_label, value) => {
    const tree = makeTree();
    approveAll(tree);
    writeJson(mcpJsonPath(tree), { mcpServers: { good: { command: 'x' }, bad: value } });
    const result = await load(tree);
    expect(result.enabled.map((s) => [s.name, s.scope, s.config])).toEqual([['good', 'project', { command: 'x' }]]);
    const names = [...result.enabled, ...result.pendingApproval, ...result.failed].map((s) => s.name);
    expect(names).not.toContain('bad');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('"bad"');
    expect(result.warnings.some((w) => w.includes('skipped the project MCP servers'))).toBe(false);
  });

  it('still skips the whole file when mcpServers itself is not an object', async () => {
    const tree = makeTree();
    approveAll(tree, { mine: { command: 'mine' } });
    const file = writeJson(mcpJsonPath(tree), { mcpServers: 1 });
    const result = await load(tree);
    expect(result.enabled.map((s) => [s.name, s.scope])).toEqual([['mine', 'user']]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.warnings.filter((w) => w.includes(file))).toHaveLength(1);
  });
});
