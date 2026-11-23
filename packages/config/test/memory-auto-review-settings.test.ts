import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { SETTINGS_SCHEMA, USER_LAYER_ONLY_PARTS, loadSettings, loadUserSettings } from '@momonga/config';
import { testKernelLock } from '@momonga/testkit';
import { connectionOf, localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';

const GUARD = 'guard/guard-model';

const GUARD_MODELS = { connections: [connectionOf('guard', { adapter: 'chat-completions', model: 'guard-model', baseUrl: 'https://api.example.com/v1', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } })] };

const UNABORTED = { lock: testKernelLock(), signal: new AbortController().signal };

const userResolved = async (settings: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  return (await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings;
};

const userRejected = async (settings: Record<string, unknown>, fragment: string | RegExp): Promise<void> => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), settings);
  await expect(loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).rejects.toThrow(fragment);
};

type MemoryAutoReviewWriter = (home: string, settingsFile: string, value: boolean, options: typeof UNABORTED) => Promise<void>;

const writeMemoryAutoReview = (): MemoryAutoReviewWriter => {
  const writer = (config as Record<string, unknown>)['writeMemoryAutoReview'];
  if (typeof writer !== 'function') throw new Error('@momonga/config does not export writeMemoryAutoReview');
  return writer as MemoryAutoReviewWriter;
};

describe('memory.autoReview and memory.autoReviewModel', () => {
  it('default to off and to no model', async () => {
    const memory = (await userResolved({})).memory as Record<string, unknown>;
    expect(memory['autoReview']).toBe(false);
    expect(memory).not.toHaveProperty('autoReviewModel');
  });

  it('are described by the settings schema under memory, the switch with the default false', () => {
    const memory = SETTINGS_SCHEMA.properties['memory'] as { properties: Record<string, Record<string, unknown>> };
    expect(memory.properties['autoReview']).toEqual({ type: 'boolean', default: false });
    expect(memory.properties['autoReviewModel']).toEqual({ type: 'string', minLength: 1 });
  });

  it('resolve from the user settings', async () => {
    const memory = (await userResolved({ memory: { autoReview: true, autoReviewModel: GUARD }, models: GUARD_MODELS })).memory as Record<string, unknown>;
    expect(memory['autoReview']).toBe(true);
    expect(memory['autoReviewModel']).toBe(GUARD);
  });

  it.each([['a string', 'yes'], ['a number', 1], ['null', null]])('refuse %s as the switch', async (_label, value) => {
    await userRejected({ memory: { autoReview: value } }, /invalid settings at \/memory\/autoReview: must be/);
  });

  it.each([['a number', 7], ['a boolean', true]])('refuse %s as the model', async (_label, value) => {
    await userRejected({ memory: { autoReviewModel: value } }, /invalid settings at \/memory\/autoReviewModel: must be/);
  });

  it('refuse an empty string as the model', async () => {
    await userRejected({ memory: { autoReviewModel: '' } }, 'invalid settings at /memory/autoReviewModel: must NOT have fewer than 1 characters');
  });

  it('are parts only the user settings can set', () => {
    expect(USER_LAYER_ONLY_PARTS).toEqual(expect.arrayContaining(['memory.autoReview', 'memory.autoReviewModel']));
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('are discarded from %s settings with a warning, keeping the other memory settings of that file', async (_label, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { memory: { autoReview: false }, models: GUARD_MODELS });
    const file = writeJson(locate(tree), { memory: { autoReview: true, autoReviewModel: GUARD, repositoryFacts: false } });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    const memory = result.settings.memory as Record<string, unknown>;
    expect(memory['autoReview']).toBe(false);
    expect(memory).not.toHaveProperty('autoReviewModel');
    expect(memory['repositoryFacts']).toBe(false);
    expect(result.warnings).toContain(`${file}: memory.autoReview is only honored in user settings; discarded`);
    expect(result.warnings).toContain(`${file}: memory.autoReviewModel is only honored in user settings; discarded`);
  });

  it('a project file cannot replace the model the user chose', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { memory: { autoReview: true, autoReviewModel: GUARD }, models: GUARD_MODELS });
    writeJson(projectSettingsPath(tree), { memory: { autoReview: false, autoReviewModel: 'attacker/model' } });
    const result = await loadSettings({ env: process.env, signal: new AbortController().signal, home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    const memory = result.settings.memory as Record<string, unknown>;
    expect(memory['autoReview']).toBe(true);
    expect(memory['autoReviewModel']).toBe(GUARD);
  });
});

describe('writeMemoryAutoReview', () => {
  it('turns the switch on and off in the user settings file and keeps every other key', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { memory: { autoReviewModel: GUARD, forgetAfterDays: 30 }, models: GUARD_MODELS, tui: { theme: 'dark' } });
    await writeMemoryAutoReview()(tree.home, file, true, UNABORTED);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ memory: { autoReviewModel: GUARD, forgetAfterDays: 30, autoReview: true }, models: GUARD_MODELS, tui: { theme: 'dark' } });
    await writeMemoryAutoReview()(tree.home, file, false, UNABORTED);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ memory: { autoReviewModel: GUARD, forgetAfterDays: 30, autoReview: false }, models: GUARD_MODELS, tui: { theme: 'dark' } });
  });

  it('creates the memory object in a file that has none', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { autoUpdates: false });
    await writeMemoryAutoReview()(tree.home, file, true, UNABORTED);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ autoUpdates: false, memory: { autoReview: true } });
    expect((await loadUserSettings({ env: process.env, home: tree.home, signal: new AbortController().signal })).settings.memory).toMatchObject({ autoReview: true });
  });

  it('leaves the file byte for byte as it was when the switch already has that value', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { memory: { autoReview: true } });
    const before = fs.readFileSync(file, 'utf8');
    await writeMemoryAutoReview()(tree.home, file, true, UNABORTED);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
