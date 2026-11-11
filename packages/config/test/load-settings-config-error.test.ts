import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadSettings } from '@momonga/config';
import { makeTree, projectSettingsPath, trusting, writeJson, writeText } from './helpers.ts';
import type { Tree } from './helpers.ts';

const failureOf = async (tree: Tree): Promise<Error> => {
  const outcome = await loadSettings({ signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) }).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error('expected loadSettings to fail');
  return outcome;
};

describe('loadSettings raises ConfigError for project settings content', () => {
  it('a missing project additionalDirectories entry', async () => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { permissions: { additionalDirectories: ['./missing'] } });
    const error = await failureOf(tree);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(file);
  });

  it('a project additionalDirectories entry that is a file', async () => {
    const tree = makeTree();
    fs.writeFileSync(path.join(tree.project, 'plain-file'), '');
    const file = writeJson(projectSettingsPath(tree), { permissions: { additionalDirectories: ['./plain-file'] } });
    const error = await failureOf(tree);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(file);
    expect(error.message).toMatch(/ is not a directory$/);
  });

  it('a malformed project settings.json', async () => {
    const tree = makeTree();
    const file = writeText(projectSettingsPath(tree), '{ broken');
    const error = await failureOf(tree);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(file);
  });

  it('project settings that fail schema validation', async () => {
    const tree = makeTree();
    const file = writeJson(projectSettingsPath(tree), { permissions: { allow: 'Bash(ls)' } });
    const error = await failureOf(tree);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(file);
  });
});
