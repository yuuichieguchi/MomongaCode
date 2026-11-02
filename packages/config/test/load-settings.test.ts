import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA, loadSettings } from '@momonga/config';
import { AUTO_MODE_UNAVAILABLE } from '@momonga/protocol';
import {
  distrusting,
  localSettingsPath,
  makeTree,
  projectSettingsPath,
  trusting,
  userSettingsPath,
  writeJson,
  writeText,
} from './helpers.ts';

describe('SETTINGS_SCHEMA', () => {
  it('is a JSON Schema 2020-12 object describing the known top-level keys', () => {
    expect(SETTINGS_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(SETTINGS_SCHEMA.type).toBe('object');
    expect(Object.keys(SETTINGS_SCHEMA.properties).sort()).toEqual(
      [
        'autoUpdates',
        'disabledMcpjsonServers',
        'enableAllProjectMcpServers',
        'enabledMcpjsonServers',
        'env',
        'mcpServers',
        'models',
        'permissions',
        'sandbox',
        'telemetry',
      ].sort(),
    );
  });
});

describe('loadSettings merge', () => {
  it('returns defaults when no files exist', async () => {
    const tree = makeTree();
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.autoUpdates).toBe(true);
    expect(result.rules).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it('merges scalars user < project < local < cli and concatenates rule arrays with origins', async () => {
    const tree = makeTree();
    const user = writeJson(userSettingsPath(tree), {
      autoUpdates: false,
      env: { DEBUG: 'user', TZ: 'user' },
      permissions: { defaultMode: 'plan', allow: ['Bash(git status)'], deny: ['Read(~/.ssh/**)'] },
    });
    const project = writeJson(projectSettingsPath(tree), {
      env: { TZ: 'project', CI: 'project' },
      permissions: { defaultMode: 'acceptEdits', allow: ['Bash(git status)', 'Read(./src/**)'] },
    });
    const local = writeJson(localSettingsPath(tree), {
      env: { CI: 'local' },
      permissions: { ask: ['Bash(npm run test:*)'] },
    });
    const result = await loadSettings({
      home: tree.home,
      projectDir: tree.project,
      cli: { permissions: { defaultMode: 'default', deny: ['Bash(rm:*)'] } },
      trust: trusting(tree),
    });
    expect(result.settings.autoUpdates).toBe(false);
    expect(result.settings.env).toEqual({ DEBUG: 'user', TZ: 'project', CI: 'local' });
    expect(result.settings.permissions?.defaultMode).toBe('default');
    expect(result.rules.map((r) => [r.text, r.effect, r.origin, r.source])).toEqual([
      ['Bash(git status)', 'allow', 'user', user],
      ['Read(~/.ssh/**)', 'deny', 'user', user],
      ['Bash(git status)', 'allow', 'project', project],
      ['Read(./src/**)', 'allow', 'project', project],
      ['Bash(npm run test:*)', 'ask', 'local', local],
      ['Bash(rm:*)', 'deny', 'cli', 'cli'],
    ]);
    expect(result.files).toEqual([user, project, local]);
  });

  it('later layers override earlier defaultMode without cli', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { defaultMode: 'plan' } });
    writeJson(localSettingsPath(tree), { permissions: { defaultMode: 'acceptEdits' } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.permissions?.defaultMode).toBe('acceptEdits');
  });

  it('concatenates additionalDirectories as absolute realpaths', async () => {
    const tree = makeTree();
    const realA = path.join(tree.home, 'extra-a');
    const realB = path.join(tree.project, 'extra-b');
    fs.mkdirSync(realA);
    fs.mkdirSync(realB);
    const link = path.join(tree.home, 'link-to-a');
    fs.symlinkSync(realA, link);
    writeJson(userSettingsPath(tree), { permissions: { additionalDirectories: [link] } });
    writeJson(projectSettingsPath(tree), { permissions: { additionalDirectories: ['./extra-b'] } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.permissions?.additionalDirectories).toEqual([realA, realB]);
  });
});

describe('loadSettings trust gate', () => {
  it('skips project settings but keeps local settings and names only the project file when the project is not trusted', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { allow: ['Read(./docs/**)'] } });
    const project = writeJson(projectSettingsPath(tree), { permissions: { allow: ['Bash(curl:*)'] } });
    const local = writeJson(localSettingsPath(tree), { permissions: { allow: ['Bash(wget:*)'] } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: distrusting() });
    expect(result.rules.map((r) => r.text)).toEqual(['Read(./docs/**)', 'Bash(wget:*)']);
    expect(result.files).toEqual([userSettingsPath(tree), local]);
    const warning = result.warnings.find((w) => /not trusted/i.test(w));
    expect(warning).toBeDefined();
    expect(warning).toContain(project);
    expect(warning).not.toContain(local);
  });

  it('does not skip anything and warns nothing when the untrusted project has no settings files', async () => {
    const tree = makeTree();
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: distrusting() });
    expect(result.warnings).toEqual([]);
  });
});

describe('loadSettings security restrictions', () => {
  it('discards models.targets and models.aliases from project and local settings with a warning', async () => {
    const tree = makeTree();
    const target = (model: string) => ({
      adapter: 'chat-completions',
      model,
      baseUrl: 'https://api.example.com/v1',
      capabilities: { contextWindow: 8192, maxOutputTokens: 1024 },
    });
    writeJson(userSettingsPath(tree), {
      models: { aliases: { default: 'local-small', fast: 'local-small' }, targets: { 'local-small': target('m1') } },
    });
    writeJson(projectSettingsPath(tree), {
      models: { aliases: { fast: 'evil' }, targets: { evil: target('x') } },
    });
    writeJson(localSettingsPath(tree), {
      models: { targets: { 'local-small': target('hijacked') } },
    });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(Object.keys(result.settings.models.targets)).toEqual(['local-small']);
    expect(result.settings.models.targets['local-small']).toMatchObject({ model: 'm1', baseUrl: 'https://api.example.com/v1' });
    expect([result.settings.models.aliases['fast']].flat()).toEqual(['local-small']);
    expect(Object.keys(result.settings.models.aliases).sort()).toEqual(['default', 'fast']);
    expect(result.warnings.filter((w) => w.includes('models.targets'))).toHaveLength(2);
    expect(result.warnings.filter((w) => w.includes('models.aliases'))).toHaveLength(1);
  });

  it('discards credential-looking env keys from project and local settings only', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { env: { OPENAI_API_KEY: 'user-value' } });
    writeJson(projectSettingsPath(tree), { env: { OPENAI_API_KEY: 'p', GITHUB_TOKEN: 'p', NODE_ENV: 'test' } });
    writeJson(localSettingsPath(tree), { env: { DB_PASSWORD: 'l', CLIENT_SECRET: 'l' } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.env).toEqual({ OPENAI_API_KEY: 'user-value', NODE_ENV: 'test' });
    for (const key of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD', 'CLIENT_SECRET']) {
      expect(result.warnings.some((w) => w.includes(key))).toBe(true);
    }
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('ignores bypassPermissions from %s settings with a warning', async (_label, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { defaultMode: 'acceptEdits' } });
    const file = writeJson(locate(tree), { permissions: { defaultMode: 'bypassPermissions' } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.permissions?.defaultMode).toBe('acceptEdits');
    expect(result.warnings.some((w) => w.includes('bypassPermissions') && w.includes(file))).toBe(true);
  });

  it('accepts bypassPermissions from user settings and from cli', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { defaultMode: 'bypassPermissions' } });
    const fromUser = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(fromUser.settings.permissions?.defaultMode).toBe('bypassPermissions');
    const other = makeTree();
    const fromCli = await loadSettings({
      home: other.home,
      projectDir: other.project,
      cli: { permissions: { defaultMode: 'bypassPermissions' } },
      trust: trusting(other),
    });
    expect(fromCli.settings.permissions?.defaultMode).toBe('bypassPermissions');
  });

  it('rejects auto mode from user settings', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { permissions: { defaultMode: 'auto' } });
    await expect(loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) })).rejects.toThrow(AUTO_MODE_UNAVAILABLE.message);
  });

  it('rejects auto mode from cli', async () => {
    const tree = makeTree();
    await expect(
      loadSettings({ home: tree.home, projectDir: tree.project, cli: { permissions: { defaultMode: 'auto' } }, trust: trusting(tree) }),
    ).rejects.toThrow(AUTO_MODE_UNAVAILABLE.message);
  });
});

describe('loadSettings validation', () => {
  it('reports malformed JSON with the file and line/column', async () => {
    const tree = makeTree();
    const file = writeText(projectSettingsPath(tree), '{\n  "env": {\n    "A": 1,,\n  }\n}\n');
    const failure = loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow(/line 3/);
    await expect(failure).rejects.toThrow(/column \d+/);
  });

  it('reports schema violations with the file and JSON pointer', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { allow: 'Bash(ls)' } });
    const failure = loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow('/permissions/allow');
  });

  it('reports an invalid permission rule naming the rule text and file', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { permissions: { deny: ['Bash(unclosed'] } });
    const failure = loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    await expect(failure).rejects.toThrow(file);
    await expect(failure).rejects.toThrow('Bash(unclosed');
  });

  it('warns about unknown top-level keys instead of failing', async () => {
    const tree = makeTree();
    const file = writeJson(userSettingsPath(tree), { futureFeature: { x: 1 }, autoUpdates: false });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.autoUpdates).toBe(false);
    expect(result.warnings.some((w) => w.includes('futureFeature') && w.includes(file))).toBe(true);
  });
});
