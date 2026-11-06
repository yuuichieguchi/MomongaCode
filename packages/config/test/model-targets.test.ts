import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { credentialEnvNames, loadSettings, loadUserSettings } from '@momonga/config';
import { localSettingsPath, makeTree, projectSettingsPath, trusting, userSettingsPath, writeJson } from './helpers.ts';
import type { Tree } from './helpers.ts';

const CAPABILITIES = { contextWindow: 128000, maxOutputTokens: 4096 };
const IMAGE_TOKENS = { pixelsPerToken: 500, maxTokens: 2000, minTokens: 1 };

const chatTarget = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  adapter: 'chat-completions',
  provider: 'fake',
  model: 'gpt-x',
  baseUrl: 'https://api.example.com/v1',
  capabilities: CAPABILITIES,
  ...overrides,
});

const DEFAULT_FM_TARGET = { adapter: 'fm', toolCalling: 'auto', billing: 'local', maxConcurrency: 1, admissionTimeoutMs: 30000 };

const resolvedCapabilities = (maxConcurrency: number) => ({
  contextWindow: 128000,
  maxOutputTokens: 4096,
  structuredOutput: 'none',
  streaming: true,
  stopSequences: true,
  tokenCounting: 'estimated',
  usageReported: true,
  source: 'config',
  maxConcurrency,
});

const members = (alias: string | string[] | undefined): string[] | undefined => (alias === undefined ? undefined : [alias].flat());

const loadWithTargets = (tree: Tree, models: Record<string, unknown>) => {
  writeJson(userSettingsPath(tree), { models });
  return loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
};

const expectRejected = async (models: Record<string, unknown>, ...fragments: Array<string | RegExp>): Promise<void> => {
  const tree = makeTree();
  const failure = loadWithTargets(tree, models);
  await expect(failure).rejects.toThrow(userSettingsPath(tree));
  for (const fragment of fragments) await expect(failure).rejects.toThrow(fragment);
};

const expectAccepted = async (models: Record<string, unknown>) => {
  const tree = makeTree();
  return (await loadWithTargets(tree, models)).settings.models;
};

describe('default targets and aliases', () => {
  it('provides the fm target and default alias when no targets are configured', async () => {
    const tree = makeTree();
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.models.targets).toEqual({ fm: DEFAULT_FM_TARGET });
    expect(members(result.settings.models.aliases['default'])).toEqual(['fm']);
    expect(Object.keys(result.settings.models.aliases)).toEqual(['default']);
    expect(result.warnings).toEqual([]);
  });

  it('points default at the first configured target and warns when no default alias exists', async () => {
    const tree = makeTree();
    const result = await loadWithTargets(tree, { targets: { zeta: chatTarget(), alpha: chatTarget({ model: 'other' }) } });
    expect(Object.keys(result.settings.models.targets)).toEqual(['zeta', 'alpha']);
    expect(members(result.settings.models.aliases['default'])).toEqual(['zeta']);
    const warning = result.warnings.find((w) => w.includes('default'));
    expect(warning).toBeDefined();
    expect(warning).toContain('zeta');
  });

  it('does not add the fm target when targets are configured', async () => {
    const models = await expectAccepted({ targets: { remote: chatTarget() }, aliases: { default: 'remote' } });
    expect(Object.keys(models.targets)).toEqual(['remote']);
  });

  it('keeps an explicit default alias without warning', async () => {
    const tree = makeTree();
    const result = await loadWithTargets(tree, { targets: { a: chatTarget(), b: chatTarget() }, aliases: { default: ['b', 'a'] } });
    expect(members(result.settings.models.aliases['default'])).toEqual(['b', 'a']);
    expect(result.warnings).toEqual([]);
  });

  it('accepts an alias in string form and in array form', async () => {
    const models = await expectAccepted({
      targets: { a: chatTarget(), b: chatTarget() },
      aliases: { default: 'a', fast: ['b', 'a'] },
    });
    expect(members(models.aliases['default'])).toEqual(['a']);
    expect(members(models.aliases['fast'])).toEqual(['b', 'a']);
  });

  it('fails the user layer when an alias names an undefined target', async () => {
    await expectRejected({ targets: { a: chatTarget() }, aliases: { default: ['a', 'ghost-target'] } }, 'ghost-target');
  });

  it('fails when an alias names an undefined target in string form', async () => {
    await expectRejected({ targets: { a: chatTarget() }, aliases: { default: 'a', fast: 'missing-one' } }, 'missing-one');
  });
});

describe('aliases are user-only', () => {
  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('drops models.aliases from %s settings with a warning naming the file', async (_label, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { models: { targets: { a: chatTarget(), b: chatTarget() }, aliases: { default: 'a', fast: 'a' } } });
    const file = writeJson(locate(tree), { models: { aliases: { fast: 'b', sneaky: 'b' } } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(members(result.settings.models.aliases['fast'])).toEqual(['a']);
    expect(result.settings.models.aliases).not.toHaveProperty('sneaky');
    expect(result.warnings.some((w) => w.includes('models.aliases') && w.includes(file))).toBe(true);
  });
});

describe('target names', () => {
  it.each(['gpt-4.1_mini', 'A', 'local.small', 'x-1'])('accepts %j', async (name) => {
    const models = await expectAccepted({ targets: { [name]: chatTarget() }, aliases: { default: name } });
    expect(Object.keys(models.targets)).toEqual([name]);
  });

  it.each(['1abc', '42', '_hidden', '-dash', '.dot', 'has space', 'café', 'a/b', ''])('rejects %j', async (name) => {
    await expectRejected({ targets: { [name]: chatTarget() } });
  });
});

describe('fm target schema', () => {
  it('fills the fm defaults', async () => {
    const models = await expectAccepted({ targets: { local: { adapter: 'fm' } }, aliases: { default: 'local' } });
    expect(models.targets['local']).toEqual(DEFAULT_FM_TARGET);
  });

  it('keeps explicit fm fields', async () => {
    const models = await expectAccepted({
      targets: { local: { adapter: 'fm', model: 'm2', toolCalling: 'constrained', maxConcurrency: 2, admissionTimeoutMs: 5000 } },
      aliases: { default: 'local' },
    });
    expect(models.targets['local']).toEqual({ adapter: 'fm', model: 'm2', toolCalling: 'constrained', billing: 'local', maxConcurrency: 2, admissionTimeoutMs: 5000 });
  });

  it.each(['auto', 'native', 'constrained'])('accepts toolCalling %j', async (toolCalling) => {
    const models = await expectAccepted({ targets: { local: { adapter: 'fm', toolCalling } }, aliases: { default: 'local' } });
    expect(models.targets['local']).toMatchObject({ toolCalling });
  });

  it.each([
    ['an unknown property', { adapter: 'fm', model: 'default', baseUrl: 'https://x.example/v1' }],
    ['an unknown toolCalling', { adapter: 'fm', model: 'default', toolCalling: 'none' }],
    ['a zero maxConcurrency', { adapter: 'fm', model: 'default', maxConcurrency: 0 }],
    ['a fractional maxConcurrency', { adapter: 'fm', model: 'default', maxConcurrency: 1.5 }],
    ['a negative admissionTimeoutMs', { adapter: 'fm', model: 'default', admissionTimeoutMs: -1 }],
    ['an unknown adapter', { adapter: 'ollama', model: 'x' }],
  ])('rejects %s', async (_label, target) => {
    await expectRejected({ targets: { local: target } });
  });
});

describe('chat-completions target schema', () => {
  it('fills the chat-completions defaults including capability defaults', async () => {
    const models = await expectAccepted({ targets: { remote: chatTarget() }, aliases: { default: 'remote' } });
    expect(models.targets['remote']).toEqual({
      adapter: 'chat-completions',
      provider: 'fake',
      model: 'gpt-x',
      baseUrl: 'https://api.example.com/v1',
      toolCalling: 'native',
      billing: 'metered',
      maxConcurrency: 4,
      admissionTimeoutMs: 30000,
      capabilities: expect.objectContaining(resolvedCapabilities(4)),
    });
    expect(Object.keys((models.targets['remote'] as { capabilities: object }).capabilities)).not.toContain('imageInput');
  });

  it('keeps a billing of local the user declares and rejects an unknown billing', async () => {
    const models = await expectAccepted({ targets: { remote: chatTarget({ billing: 'local' }) }, aliases: { default: 'remote' } });
    expect(models.targets['remote']).toMatchObject({ billing: 'local' });
    await expectRejected({ targets: { remote: chatTarget({ billing: 'free' }) }, aliases: { default: 'remote' } });
  });

  it('takes capabilities.maxConcurrency from the target', async () => {
    const models = await expectAccepted({ targets: { remote: chatTarget({ maxConcurrency: 7 }) }, aliases: { default: 'remote' } });
    expect(models.targets['remote']).toMatchObject({ maxConcurrency: 7, capabilities: { maxConcurrency: 7 } });
  });

  it('keeps explicit capability values over the defaults', async () => {
    const models = await expectAccepted({
      targets: {
        remote: chatTarget({
          capabilities: { ...CAPABILITIES, structuredOutput: 'json_schema', streaming: false, tokenCounting: 'exact', imageInput: true, imageTokens: IMAGE_TOKENS },
        }),
      },
      aliases: { default: 'remote' },
    });
    expect(models.targets['remote']).toMatchObject({
      capabilities: { structuredOutput: 'json_schema', streaming: false, tokenCounting: 'exact', imageInput: true, stopSequences: true },
    });
  });

  it.each(['http://user:hunter2@api.example.com/v1', 'https://user:hunter2@api.example.com/v1', 'http://user:hunter2@127.0.0.1:8080/v1'])(
    'refuses userinfo in %s without printing the password',
    async (baseUrl) => {
      const tree = makeTree();
      const failure = loadWithTargets(tree, { targets: { remote: chatTarget({ baseUrl }) }, aliases: { default: 'remote' } });
      await expect(failure).rejects.toThrow('must not contain userinfo');
      await expect(failure).rejects.not.toThrow(/hunter2/);
    },
  );

  it('does not print the credential of a cleartext remote URL', async () => {
    const tree = makeTree();
    const failure = loadWithTargets(tree, { targets: { remote: chatTarget({ baseUrl: 'http://api.example.com/v1?key=hunter2' }) }, aliases: { default: 'remote' } });
    await expect(failure).rejects.toThrow('must use https');
    await expect(failure).rejects.not.toThrow(/hunter2/);
  });

  it.each(['chat-completions', 'open-responses'])('requires provider on a %s target', async (adapter) => {
    const { provider: _provider, ...withoutProvider } = chatTarget({ adapter });
    await expectRejected({ targets: { remote: withoutProvider }, aliases: { default: 'remote' } }, 'provider');
  });

  it('requires imageTokens when a remote target declares imageInput', async () => {
    await expectRejected(
      { targets: { remote: chatTarget({ capabilities: { ...CAPABILITIES, imageInput: true } }) }, aliases: { default: 'remote' } },
      'capabilities.imageTokens',
    );
  });

  it('accepts a per-image minimum in the declared imageTokens and keeps it', async () => {
    const imageTokens = { ...IMAGE_TOKENS, minTokens: 576 };
    const models = await expectAccepted({
      targets: { remote: chatTarget({ capabilities: { ...CAPABILITIES, imageInput: true, imageTokens } }) },
      aliases: { default: 'remote' },
    });
    expect(models.targets['remote']).toMatchObject({ capabilities: { imageTokens } });
  });

  it('keeps the declared imageTokens on the resolved capabilities', async () => {
    const models = await expectAccepted({
      targets: { remote: chatTarget({ capabilities: { ...CAPABILITIES, imageInput: true, imageTokens: IMAGE_TOKENS } }) },
      aliases: { default: 'remote' },
    });
    expect(models.targets['remote']).toMatchObject({ capabilities: { imageTokens: IMAGE_TOKENS } });
  });

  it.each(['http://127.0.0.1:8080/v1', 'http://localhost:1234/v1', 'http://[::1]:8080/v1', 'https://api.example.com/v1', 'https://api.example.com:8443/openai/v1'])(
    'accepts baseUrl %s',
    async (baseUrl) => {
      const models = await expectAccepted({ targets: { remote: chatTarget({ baseUrl }) }, aliases: { default: 'remote' } });
      expect(models.targets['remote']).toMatchObject({ baseUrl });
    },
  );

  it.each([
    ['plain http to a remote host', 'http://api.example.com/v1'],
    ['plain http to a loopback-looking hostname', 'http://127.0.0.1.example.com/v1'],
    ['a userinfo component', 'https://user:pass@api.example.com/v1'],
    ['a username only', 'https://user@api.example.com/v1'],
    ['a query', 'https://api.example.com/v1?key=1'],
    ['a fragment', 'https://api.example.com/v1#frag'],
    ['a non-http scheme', 'ftp://api.example.com/v1'],
    ['a non-URL', 'not a url'],
  ])('rejects a baseUrl with %s', async (_label, baseUrl) => {
    await expectRejected({ targets: { remote: chatTarget({ baseUrl }) } });
  });

  it('accepts an absolute socketPath outside the momonga run directory', async () => {
    const tree = makeTree();
    const socketPath = path.join(tree.home, 'llm', 'server.sock');
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    const { baseUrl: _omitted, ...rest } = chatTarget({ socketPath });
    const result = await loadWithTargets(tree, { targets: { remote: rest }, aliases: { default: 'remote' } });
    expect(result.settings.models.targets['remote']).toMatchObject({ socketPath });
    expect(result.settings.models.targets['remote']).not.toHaveProperty('baseUrl');
  });

  it('rejects a relative socketPath', async () => {
    const { baseUrl: _omitted, ...rest } = chatTarget({ socketPath: 'llm/server.sock' });
    await expectRejected({ targets: { remote: rest } }, 'socketPath');
  });

  it('rejects a socketPath inside <home>/.momonga/run, naming it', async () => {
    const tree = makeTree();
    const socketPath = path.join(tree.home, '.momonga', 'run', 'gateway.sock');
    const { baseUrl: _omitted, ...rest } = chatTarget({ socketPath });
    const failure = loadWithTargets(tree, { targets: { remote: rest } });
    await expect(failure).rejects.toThrow(socketPath);
  });

  it('rejects a socketPath that only resolves into <home>/.momonga/run through dot segments', async () => {
    const tree = makeTree();
    const socketPath = path.join(tree.home, 'llm') + '/../.momonga/run/fm.sock';
    const { baseUrl: _omitted, ...rest } = chatTarget({ socketPath });
    await expect(loadWithTargets(tree, { targets: { remote: rest } })).rejects.toThrow(/\.momonga/);
  });

  it('rejects a socketPath that resolves into <home>/.momonga/run through a symlink', async () => {
    const tree = makeTree();
    fs.mkdirSync(path.join(tree.home, '.momonga', 'run'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(path.join(tree.home, '.momonga', 'run'), path.join(tree.home, 'innocent'));
    const socketPath = path.join(tree.home, 'innocent', 'fm.sock');
    const { baseUrl: _omitted, ...rest } = chatTarget({ socketPath });
    await expect(loadWithTargets(tree, { targets: { remote: rest } })).rejects.toThrow(socketPath);
  });

  it('rejects both baseUrl and socketPath', async () => {
    await expectRejected({ targets: { remote: chatTarget({ socketPath: '/var/run/llm.sock' }) } });
  });

  it('rejects neither baseUrl nor socketPath', async () => {
    const { baseUrl: _omitted, ...rest } = chatTarget();
    await expectRejected({ targets: { remote: rest } });
  });

  it('rejects a missing model', async () => {
    const { model: _omitted, ...rest } = chatTarget();
    await expectRejected({ targets: { remote: rest } });
  });

  it.each(['OPENAI_API_KEY', '_KEY', 'a1'])('accepts apiKeyEnv %j', async (apiKeyEnv) => {
    const models = await expectAccepted({ targets: { remote: chatTarget({ apiKeyEnv }) }, aliases: { default: 'remote' } });
    expect(models.targets['remote']).toMatchObject({ apiKeyEnv });
  });

  it.each(['openai', 'azure.ai.openai', 'gcp.vertex_ai', 'my-gateway'])('accepts provider %j', async (provider) => {
    const models = await expectAccepted({ targets: { remote: chatTarget({ provider }) }, aliases: { default: 'remote' } });
    expect(models.targets['remote']).toMatchObject({ provider });
  });

  it.each(['', 'OpenAI', '1x', 'has space'])('rejects provider %j', async (provider) => {
    await expectRejected({ targets: { remote: chatTarget({ provider }) } });
  });

  it.each(['1KEY', 'BAD-NAME', 'HAS SPACE', '', 'X=Y'])('rejects apiKeyEnv %j', async (apiKeyEnv) => {
    await expectRejected({ targets: { remote: chatTarget({ apiKeyEnv }) } });
  });

  it.each(['auto', 'native', 'constrained'])('accepts toolCalling %j', async (toolCalling) => {
    const models = await expectAccepted({ targets: { remote: chatTarget({ toolCalling }) }, aliases: { default: 'remote' } });
    expect(models.targets['remote']).toMatchObject({ toolCalling });
  });

  it.each([
    ['toolCalling none', { toolCalling: 'none' }],
    ['capabilities.toolCalling', { capabilities: { ...CAPABILITIES, toolCalling: 'native' } }],
    ['capabilities without contextWindow', { capabilities: { maxOutputTokens: 4096 } }],
    ['capabilities without maxOutputTokens', { capabilities: { contextWindow: 128000 } }],
    ['no capabilities', { capabilities: undefined }],
    ['an unknown property', { temperature: 0.2 }],
    ['a zero maxConcurrency', { maxConcurrency: 0 }],
  ])('rejects %s', async (_label, overrides) => {
    const target = Object.fromEntries(Object.entries(chatTarget(overrides)).filter(([, value]) => value !== undefined));
    await expectRejected({ targets: { remote: target } });
  });
});

describe('credentialEnvNames', () => {
  it('returns the sorted unique apiKeyEnv values', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), {
      models: {
        targets: {
          a: chatTarget({ apiKeyEnv: 'ZED_KEY' }),
          b: chatTarget({ apiKeyEnv: 'ALPHA_KEY' }),
          c: chatTarget({ apiKeyEnv: 'ZED_KEY' }),
          d: chatTarget(),
          e: { adapter: 'fm' },
        },
        aliases: { default: 'a' },
      },
    });
    const { settings } = await loadUserSettings({ home: tree.home });
    expect(credentialEnvNames(settings)).toEqual(['ALPHA_KEY', 'ZED_KEY']);
  });

  it('returns an empty list for the default settings', async () => {
    const tree = makeTree();
    const { settings } = await loadUserSettings({ home: tree.home });
    expect(credentialEnvNames(settings)).toEqual([]);
  });
});

const ORDERED_SUBSET = {
  extends: 'inlined-subset',
  rules: [{ select: [{ kinds: ['object-with-properties'] }], op: 'property-order', key: 'propertyOrdering' }],
};

const BUILTIN_IDS = ['json-schema-2020-12', 'explicit-keys', 'strict-closed', 'inlined-subset'];

describe('user-declared dialects', () => {
  it('resolves models.dialects from user settings as declared', async () => {
    const models = await expectAccepted({ dialects: { 'ordered-subset': ORDERED_SUBSET } });
    expect(models.dialects).toEqual({ 'ordered-subset': ORDERED_SUBSET });
  });

  it('resolves no dialects when none are declared', async () => {
    const models = await expectAccepted({ targets: { a: chatTarget() }, aliases: { default: 'a' } });
    expect(models.dialects).toEqual({});
  });

  it.each([
    ['project', projectSettingsPath],
    ['local', localSettingsPath],
  ] as const)('discards models.dialects from %s settings with a warning naming the file', async (_label, locate) => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { models: { dialects: { 'ordered-subset': ORDERED_SUBSET } } });
    const file = writeJson(locate(tree), { models: { dialects: { 'project-dialect': { rules: [] } } } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.models.dialects).toEqual({ 'ordered-subset': ORDERED_SUBSET });
    expect(result.warnings.some((w) => w.includes('models.dialects is only honored in user settings') && w.includes(file))).toBe(true);
  });

  it('leaves the defaults of a project layer that only declared dialects', async () => {
    const tree = makeTree();
    writeJson(projectSettingsPath(tree), { models: { dialects: { 'project-dialect': { rules: [] } } } });
    const result = await loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    expect(result.settings.models.dialects).toEqual({});
    expect(result.settings.models.targets).toEqual({ fm: DEFAULT_FM_TARGET });
  });

  it.each([
    ['an unknown op', { rules: [{ select: [{ kinds: ['any'] }], op: 'rename' }] }],
    ['ensure-key of an assertion keyword', { rules: [{ select: [{ kinds: ['any'] }], op: 'ensure-key', key: 'minimum', value: 0 }] }],
    ['nullable-optional on a root clause', { rules: [{ select: [{ kinds: ['root'] }], op: 'nullable-optional' }] }],
    ['no rules', {}],
  ])('rejects a definition with %s against the definition schema, naming the id', async (_name, definition) => {
    await expectRejected({ dialects: { 'broken-one': definition } }, 'broken-one');
  });

  it.each(['Upper', '1digit', 'has space', `a${'b'.repeat(63)}`])('rejects the dialect id %j', async (id) => {
    await expectRejected({ dialects: { [id]: { rules: [] } } }, id);
  });

  it.each(BUILTIN_IDS)('rejects a user dialect that reuses the built-in id %s', async (id) => {
    await expectRejected({ dialects: { [id]: { rules: [] } } }, id, /built-in/);
  });

  it('rejects a user dialect that extends a dialect that is not built in, naming both ids', async () => {
    await expectRejected(
      { dialects: { 'ordered-subset': ORDERED_SUBSET, 'second-level': { extends: 'ordered-subset', rules: [] } } },
      'second-level',
      'ordered-subset',
    );
  });
});

describe('the dialect a target declares', () => {
  it.each(BUILTIN_IDS)('accepts the built-in %s', async (id) => {
    const models = await expectAccepted({ targets: { a: chatTarget({ capabilities: { ...CAPABILITIES, schemaDialect: id } }) }, aliases: { default: 'a' } });
    expect(models.targets['a']).toMatchObject({ capabilities: { schemaDialect: id } });
  });

  it('accepts a dialect declared in the same user settings', async () => {
    const models = await expectAccepted({
      dialects: { 'ordered-subset': ORDERED_SUBSET },
      targets: { a: chatTarget({ capabilities: { ...CAPABILITIES, schemaDialect: 'ordered-subset' } }) },
      aliases: { default: 'a' },
    });
    expect(models.targets['a']).toMatchObject({ capabilities: { schemaDialect: 'ordered-subset' } });
  });

  it('rejects a dialect id that is neither built in nor declared, naming the id', async () => {
    await expectRejected(
      { targets: { a: chatTarget({ capabilities: { ...CAPABILITIES, schemaDialect: 'nowhere-dialect' } }) }, aliases: { default: 'a' } },
      'nowhere-dialect',
    );
  });

  it('does not resolve a target dialect against a dialect a project layer declared', async () => {
    const tree = makeTree();
    writeJson(userSettingsPath(tree), { models: { targets: { a: chatTarget({ capabilities: { ...CAPABILITIES, schemaDialect: 'project-dialect' } }) }, aliases: { default: 'a' } } });
    writeJson(projectSettingsPath(tree), { models: { dialects: { 'project-dialect': { rules: [] } } } });
    const failure = loadSettings({ home: tree.home, projectDir: tree.project, cli: {}, trust: trusting(tree) });
    await expect(failure).rejects.toThrow('project-dialect');
  });

  it('writes no dialect into a target that declares none, so the probe record can decide it', async () => {
    const models = await expectAccepted({ targets: { a: chatTarget() }, aliases: { default: 'a' } });
    expect(models.targets['a']?.adapter).toBe('chat-completions');
    expect(Object.keys((models.targets['a'] as { capabilities: object }).capabilities)).not.toContain('schemaDialect');
  });
});
