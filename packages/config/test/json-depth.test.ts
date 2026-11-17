import { describe, expect, it } from 'vitest';
import { loadMcpServers, loadSettings } from '@momonga/config';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { makeTree, mcpJsonPath, projectSettingsPath, trusting, userSettingsPath, writeText } from './helpers.ts';

const nestedArraysText = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const withExtra = (depth: number): string => `{"env":{"A":${nestedArraysText(depth - 2)}}}`;

const mcpJsonText = (depth: number): string => `{"mcpServers":{"a":{"command":"x","extra":${nestedArraysText(depth - 3)}}}}`;

const ENV = {};

const failureOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
};

const namesDepth = (text: string): boolean => /depth/i.test(text) && text.includes(String(MAX_JSON_DEPTH));

describe('settings files and the one JSON depth bound', () => {
  it.each([
    ['user', userSettingsPath],
    ['project', projectSettingsPath],
  ])(`refuses %s settings nested ${MAX_JSON_DEPTH + 1} deep, naming the file and the depth`, async (_scope, pathOf) => {
    const tree = makeTree();
    const file = writeText(pathOf(tree), withExtra(MAX_JSON_DEPTH + 1));
    const failure = await failureOf(loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }));
    expect(failure.message).toContain(file);
    expect(namesDepth(failure.message)).toBe(true);
  });

  it(`passes settings nested exactly ${MAX_JSON_DEPTH} deep on to schema validation`, async () => {
    const tree = makeTree();
    const file = writeText(projectSettingsPath(tree), withExtra(MAX_JSON_DEPTH));
    const failure = await failureOf(loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }));
    expect(failure.message).toContain(file);
    expect(failure.message).toContain('/env/A');
    expect(/depth/i.test(failure.message)).toBe(false);
  });
});

describe('.mcp.json and the one JSON depth bound', () => {
  it(`warns about a .mcp.json nested ${MAX_JSON_DEPTH + 1} deep, naming the file and the depth`, async () => {
    const tree = makeTree();
    const file = writeText(mcpJsonPath(tree), mcpJsonText(MAX_JSON_DEPTH + 1));
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: ENV, referenceEnv: ENV });
    expect(result.enabled).toEqual([]);
    expect(result.pendingApproval).toEqual([]);
    expect(result.warnings.filter((warning) => warning.includes(file) && namesDepth(warning))).toHaveLength(1);
  });

  it(`does not name the depth for a .mcp.json nested exactly ${MAX_JSON_DEPTH} deep`, async () => {
    const tree = makeTree();
    writeText(mcpJsonPath(tree), mcpJsonText(MAX_JSON_DEPTH));
    const result = await loadMcpServers({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, trust: trusting(tree), env: ENV, referenceEnv: ENV });
    expect(result.warnings.filter((warning) => /depth/i.test(warning))).toEqual([]);
  });
});
