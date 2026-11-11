import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMcpServers, loadSettings } from '@momonga/config';
import { setCaseSensitivityProbe } from '@momonga/foundation';
import { connectionOf, makeDir, makeTree, mcpJsonPath, modelOf, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const kernelFoldsCase = (): boolean => {
  const probe = path.join(makeDir(), 'CaseProbe');
  fs.mkdirSync(probe);
  try {
    return fs.statSync(probe).ino === fs.statSync(path.join(path.dirname(probe), 'caseprobe')).ino;
  } catch {
    return false;
  }
};

const CASE_INSENSITIVE = kernelFoldsCase();

const caseVariant = (absolute: string): string => path.join(path.dirname(absolute), path.basename(absolute).toUpperCase());

const CAPABILITIES = { contextWindow: 128000, maxOutputTokens: 4096 };

const socketTarget = (socketPath: string) => ({ adapter: 'chat-completions', provider: 'fake', model: 'gpt-x', socketPath, capabilities: CAPABILITIES });

const loadWithSocket = (tree: Tree, socketPath: string) => {
  writeJson(userSettingsPath(tree), { models: { connections: [connectionOf('remote', socketTarget(socketPath))] } });
  return loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
};

const loadMcp = (tree: Tree) => loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: {} });

const approveAll = (tree: Tree): void => {
  writeJson(userSettingsPath(tree), { enableAllProjectMcpServers: true });
};

describe('project additionalDirectories containment', () => {
  it.runIf(CASE_INSENSITIVE)('keeps a project additionalDirectories entry typed in a different case', async () => {
    const tree = makeTree();
    const inside = path.join(tree.project, 'inside');
    fs.mkdirSync(inside);
    writeJson(projectSettingsPath(tree), { permissions: { additionalDirectories: [path.join(caseVariant(tree.project), 'INSIDE')] } });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: caseVariant(tree.project), cli: {}, trust: { isTrusted: () => true } });
    expect(result.settings.permissions.additionalDirectories).toEqual([inside]);
    expect(result.warnings.filter((warning) => warning.includes('additionalDirectories'))).toEqual([]);
  });

  it('still discards a project entry outside the project', async () => {
    const tree = makeTree();
    const outside = makeDir();
    const file = writeJson(projectSettingsPath(tree), { permissions: { additionalDirectories: [outside] } });
    const result = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.permissions.additionalDirectories).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes(file) && warning.includes('outside the project'))).toBe(true);
  });
});

describe('.mcp.json symlink confinement', () => {
  it.runIf(CASE_INSENSITIVE)('reads a .mcp.json symlink into the project through a case variant', async () => {
    const tree = makeTree();
    approveAll(tree);
    writeJson(path.join(tree.project, 'shared', 'mcp.json'), { mcpServers: { a: { command: 'a' } } });
    fs.symlinkSync(path.join(caseVariant(tree.project), 'SHARED', 'mcp.json'), mcpJsonPath(tree));
    const result = await loadMcp(tree);
    expect(result.enabled.map((entry) => [entry.name, entry.scope])).toEqual([['a', 'project']]);
    expect(result.warnings.filter((warning) => warning.includes(mcpJsonPath(tree)))).toEqual([]);
  });

  it('still skips a .mcp.json symlink outside the project', async () => {
    const tree = makeTree();
    approveAll(tree);
    const outside = writeJson(path.join(makeDir(), 'm.json'), { mcpServers: { a: { command: 'a' } } });
    fs.symlinkSync(outside, mcpJsonPath(tree));
    const result = await loadMcp(tree);
    expect(result.enabled).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes(mcpJsonPath(tree)))).toBe(true);
  });
});

describe('socketPath containment', () => {
  it.runIf(CASE_INSENSITIVE)('rejects a socketPath inside the run directory typed in a different case', async () => {
    const tree = makeTree();
    const socketPath = path.join(tree.home, '.momonga', 'RUN', 'fm.sock');
    await expect(loadWithSocket(tree, socketPath)).rejects.toThrow(socketPath);
  });

  it.runIf(CASE_INSENSITIVE)('rejects a socketPath whose existing .momonga component is typed in a different case', async () => {
    const tree = makeTree();
    const socketPath = path.join(tree.home, '.MOMONGA', 'run', 'fm.sock');
    await expect(loadWithSocket(tree, socketPath)).rejects.toThrow(socketPath);
  });

  it('accepts a missing-tail case variant of the run directory when the volume probe reports case-sensitive', async () => {
    setCaseSensitivityProbe(() => false);
    try {
      const tree = makeTree();
      const socketPath = path.join(tree.home, '.momonga', 'RUN', 'fm.sock');
      const result = await loadWithSocket(tree, socketPath);
      expect(modelOf(result.settings, 'remote')).toMatchObject({ socketPath });
    } finally {
      setCaseSensitivityProbe(undefined);
    }
  });

  it('accepts a socketPath outside the run directory', async () => {
    const tree = makeTree();
    const socketPath = path.join(tree.home, 'llm', 'server.sock');
    const result = await loadWithSocket(tree, socketPath);
    expect(modelOf(result.settings, 'remote')).toMatchObject({ socketPath });
  });
});
