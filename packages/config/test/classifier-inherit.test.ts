import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { INHERITED_CLASSIFIER, SETTINGS_SCHEMA, loadSettings } from '@momonga/config';
import { connectionsOf, localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const chatModel = (model: string): Record<string, unknown> => ({
  adapter: 'chat-completions',
  model,
  baseUrl: `https://${model}.example.com/v1`,
  capabilities: { contextWindow: 128000, maxOutputTokens: 4096 },
});

const load = (tree: Tree) => loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });

const loadWith = (tree: Tree, written: Record<string, unknown>) => {
  writeJson(userSettingsPath(tree), written);
  return load(tree);
};

describe('autoMode.classifier "inherit"', () => {
  it('is valid and resolves to no classifier, exactly like an absent classifier', async () => {
    const connections = connectionsOf({ main: chatModel('big') });
    const inherited = await loadWith(makeTree(), { autoMode: { classifier: 'inherit' }, models: { connections } });
    const absent = await loadWith(makeTree(), { models: { connections } });
    expect(inherited.settings.models.classifier).toBeUndefined();
    expect(absent.settings.models.classifier).toBeUndefined();
    expect(inherited.warnings).toEqual([]);
  });

  it('is not read as the model whose own name is inherit', async () => {
    const connections = connectionsOf({ main: chatModel('big'), guard: chatModel('inherit') });
    const result = await loadWith(makeTree(), { autoMode: { classifier: 'inherit' }, models: { connections } });
    expect(result.settings.models.classifier).toBeUndefined();
  });

  it('leaves the model whose own name is inherit addressable as <provider>/inherit', async () => {
    const connections = connectionsOf({ main: chatModel('big'), guard: chatModel('inherit') });
    const result = await loadWith(makeTree(), { autoMode: { classifier: 'guard/inherit' }, models: { connections } });
    expect(result.settings.models.classifier).toBe('guard/inherit');
  });

  it('keeps a name that is not a configured model a config error', async () => {
    const tree = makeTree();
    const connections = connectionsOf({ main: chatModel('big'), small: chatModel('little') });
    const failure = loadWith(tree, { autoMode: { classifier: 'ghost' }, models: { connections } });
    await expect(failure).rejects.toThrow(userSettingsPath(tree));
    await expect(failure).rejects.toThrow('autoMode.classifier: "ghost" is not a configured model; configured models: big, little');
  });
});

describe('the documented default "inherit" of autoMode.classifier', () => {
  it('is stated in the schema', () => {
    expect(SETTINGS_SCHEMA.properties.autoMode.properties.classifier.default).toBe(INHERITED_CLASSIFIER);
  });

  it('is never written into loaded documents: no layer without autoMode gains one, and no layer warns', async () => {
    const tree = makeTree();
    const user = { models: { connections: connectionsOf({ main: chatModel('big') }) } };
    const shared = { permissions: { allow: ['Read'] } };
    writeJson(userSettingsPath(tree), user);
    writeJson(projectSettingsPath(tree), shared);
    writeJson(localSettingsPath(tree), shared);
    const result = await load(tree);
    expect(result.warnings).toEqual([]);
    expect(result.settings).not.toHaveProperty('autoMode');
    expect(result.settings.models.classifier).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(userSettingsPath(tree), 'utf8'))).toEqual(user);
    expect(JSON.parse(fs.readFileSync(projectSettingsPath(tree), 'utf8'))).toEqual(shared);
    expect(JSON.parse(fs.readFileSync(localSettingsPath(tree), 'utf8'))).toEqual(shared);
  });
});
