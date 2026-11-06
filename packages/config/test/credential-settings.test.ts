import { describe, expect, it } from 'vitest';
import { loadSettings } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const CREDENTIALS = { env: ['MYCO_*', 'SERVICE_ID'], keep: ['SSH_AUTH_SOCK'], valuePatterns: ['^ghp_'] };

const load = (tree: ReturnType<typeof makeTree>, cli: Record<string, unknown> = {}) =>
  loadSettings({ home: tree.home, projectDir: tree.project, cli: cli as never, trust: trusting(tree) });

const credentialsOf = (settings: unknown): unknown => (settings as { credentials?: unknown }).credentials;

describe('credentials settings', () => {
  it('honours credentials.env, credentials.keep and credentials.valuePatterns from user settings', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { credentials: CREDENTIALS });
    const result = await load(tree);
    expect(credentialsOf(result.settings)).toEqual(CREDENTIALS);
    expect(result.warnings).toEqual([]);
  });

  it('honours credentials from the CLI layer', async () => {
    const tree = makeTree();
    const result = await load(tree, { credentials: { keep: ['TERM_SESSION_ID'] } });
    expect(credentialsOf(result.settings)).toMatchObject({ keep: ['TERM_SESSION_ID'] });
  });

  it('defaults every credentials list to empty', async () => {
    const tree = makeTree();
    const result = await load(tree);
    expect(credentialsOf(result.settings)).toEqual({ env: [], keep: [], valuePatterns: [] });
  });

  it.each(['env', 'keep', 'valuePatterns'] as const)('discards credentials.%s from project settings with a warning naming the file', async (key) => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { credentials: { [key]: ['SSH_AUTH_SOCK'] } });
    const result = await load(tree);
    expect(credentialsOf(result.settings)).toEqual({ env: [], keep: [], valuePatterns: [] });
    expect(result.warnings.filter((warning) => warning.includes(file) && warning.includes('credentials'))).toHaveLength(1);
  });

  it('rejects a value pattern that is not a regular expression, naming the pointer', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { credentials: { valuePatterns: ['('] } });
    await expect(load(tree)).rejects.toThrow('/credentials/valuePatterns/0');
  });
});
