import { describe, expect, it } from 'vitest';
import { credentialEnvNames, loadUserSettings, planAccountNames, secretNames } from '@momonga/config';
import { makeTree, userSettingsPath, writeJson } from './helpers.ts';

const planTarget = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  adapter: 'open-responses',
  model: 'gpt-fake',
  plan: { profile: 'chatgpt' },
  ...overrides,
});

const load = async (models: Record<string, unknown>) => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models });
  return { tree, result: await loadUserSettings({ home: tree.home }) };
};

const loadTargets = (targets: Record<string, unknown>, aliases: Record<string, unknown> = { default: Object.keys(targets)[0] }) => load({ targets, aliases });

const expectRejected = async (models: Record<string, unknown>, ...fragments: Array<string | RegExp>): Promise<void> => {
  const tree = makeTree();
  writeJson(userSettingsPath(tree), { models });
  const failure = loadUserSettings({ home: tree.home });
  await expect(failure).rejects.toThrow(userSettingsPath(tree));
  for (const fragment of fragments) await expect(failure).rejects.toThrow(fragment);
};

describe('a plan target', () => {
  it('resolves with the profile defaults under the open-responses defaults and no number invented', async () => {
    const { result } = await loadTargets({ gpt: planTarget() });
    expect(result.settings.models.targets['gpt']).toEqual({
      adapter: 'open-responses',
      model: 'gpt-fake',
      baseUrl: 'https://api.openai.com/v1',
      provider: 'chatgpt',
      toolCalling: 'native',
      billing: 'plan',
      plan: { profile: 'chatgpt' },
      capabilities: {
        structuredOutput: 'none',
        streaming: true,
        stopSequences: false,
        tokenCounting: 'estimated',
        usageReported: true,
        source: 'config',
        sampling: { accepts: 'none' },
        outputBoundField: 'none',
        systemRole: 'developer',
        toolPlacement: 'additional_tools',
        inputKinds: { content: ['text', 'image'], tools: ['function', 'custom'] },
        maxConcurrency: 4,
      },
      maxConcurrency: 4,
      admissionTimeoutMs: 30000,
    });
  });

  it('does not set contextWindow, maxOutputTokens, promptCache or reasoning', async () => {
    const { result } = await loadTargets({ gpt: planTarget() });
    const target = result.settings.models.targets['gpt'];
    for (const key of ['contextWindow', 'maxOutputTokens', 'promptCache', 'reasoning']) expect(target?.adapter === 'fm' ? {} : target?.capabilities).not.toHaveProperty(key);
  });

  it('keeps the account label that pins the target', async () => {
    const { result } = await loadTargets({ gpt: planTarget({ plan: { profile: 'chatgpt', account: 'work' } }) });
    expect(result.settings.models.targets['gpt']).toMatchObject({ plan: { profile: 'chatgpt', account: 'work' } });
  });

  it('lets a declared capability win over the profile and over the defaults', async () => {
    const { result } = await loadTargets({
      gpt: planTarget({ capabilities: { contextWindow: 400000, maxOutputTokens: 32000, systemRole: 'system', toolPlacement: 'top_level' } }),
    });
    expect(result.settings.models.targets['gpt']).toMatchObject({
      capabilities: { contextWindow: 400000, maxOutputTokens: 32000, systemRole: 'system', toolPlacement: 'top_level', outputBoundField: 'none' },
    });
  });

  it('lets a declared billing win over the profile default', async () => {
    const { result } = await loadTargets({ gpt: planTarget({ billing: 'metered' }) });
    expect(result.settings.models.targets['gpt']).toMatchObject({ billing: 'metered' });
  });

  it('keeps a declared provider and base URL on the resource origin', async () => {
    const { result } = await loadTargets({ gpt: planTarget({ provider: 'openai', baseUrl: 'https://api.openai.com/v1/' }) });
    expect(result.settings.models.targets['gpt']).toMatchObject({ provider: 'openai', baseUrl: 'https://api.openai.com/v1/' });
  });

  it('is exempt from the declared number rule that every other open-responses target keeps', async () => {
    await expectRejected(
      { targets: { other: { adapter: 'open-responses', provider: 'fake', model: 'm', baseUrl: 'http://127.0.0.1:11434/v1', capabilities: { maxOutputTokens: 100 } } } },
      /contextWindow/,
    );
  });
});

describe('config errors of a plan target', () => {
  it('refuses a plan together with apiKeyEnv', async () => {
    await expectRejected({ targets: { gpt: planTarget({ apiKeyEnv: 'OPENAI_API_KEY' }) } }, /models\.targets\.gpt/, /plan/, /apiKeyEnv/);
  });

  it('refuses a plan together with apiKeySecret', async () => {
    await expectRejected({ targets: { gpt: planTarget({ apiKeySecret: 'openai' }) } }, /models\.targets\.gpt/, /plan/, /apiKeySecret/);
  });

  it('refuses an unknown profile naming the profile', async () => {
    await expectRejected({ targets: { gpt: planTarget({ plan: { profile: 'nowhere' } }) } }, /models\.targets\.gpt/, /nowhere/);
  });

  it('refuses a plan on a target whose adapter is not the profile adapter', async () => {
    await expectRejected(
      { targets: { gpt: { adapter: 'chat-completions', provider: 'fake', model: 'm', baseUrl: 'https://api.openai.com/v1', capabilities: { contextWindow: 1000, maxOutputTokens: 100 }, plan: { profile: 'chatgpt' } } } },
      /models\.targets\.gpt/,
      'profile chatgpt requires adapter open-responses',
    );
  });

  it('refuses a base URL whose origin differs from the profile resource', async () => {
    await expectRejected({ targets: { gpt: planTarget({ baseUrl: 'https://example.com/v1' }) } }, /models\.targets\.gpt/, /baseUrl/, 'https://api.openai.com');
  });

  it('refuses a base URL on the same host with another scheme or port', async () => {
    await expectRejected({ targets: { gpt: planTarget({ baseUrl: 'https://api.openai.com:8443/v1' }) } }, /baseUrl/);
  });

  it('refuses a socketPath', async () => {
    await expectRejected({ targets: { gpt: planTarget({ socketPath: '/tmp/relay.sock' }) } }, /models\.targets\.gpt/, /socketPath/);
  });

  it('refuses a plan without a profile', async () => {
    await expectRejected({ targets: { gpt: planTarget({ plan: {} }) } }, /profile/);
  });

  it('refuses an account label that is not a name', async () => {
    await expectRejected({ targets: { gpt: planTarget({ plan: { profile: 'chatgpt', account: 'has space' } }) } }, /account/);
  });

  it('refuses a profile written into a settings file', async () => {
    await expectRejected({ planProfiles: { mine: { id: 'mine' } } }, /planProfiles/);
  });
});

describe('the credential reference invariants', () => {
  it('I-P1: a resolved target holds zero or one of apiKeyEnv, apiKeySecret and plan', async () => {
    const { result } = await loadTargets({
      plan: planTarget(),
      env: { adapter: 'open-responses', provider: 'fake', model: 'm', baseUrl: 'https://example.com/v1', apiKeyEnv: 'KEY_ONE', capabilities: { contextWindow: 1000, maxOutputTokens: 100 } },
      secret: { adapter: 'open-responses', provider: 'fake', model: 'm', baseUrl: 'https://example.com/v1', apiKeySecret: 'key-two', capabilities: { contextWindow: 1000, maxOutputTokens: 100 } },
      bare: { adapter: 'open-responses', provider: 'fake', model: 'm', baseUrl: 'https://example.com/v1', capabilities: { contextWindow: 1000, maxOutputTokens: 100 } },
    });
    for (const target of Object.values(result.settings.models.targets)) {
      const held = ['apiKeyEnv', 'apiKeySecret', 'plan'].filter((key) => key in target);
      expect(held.length).toBeLessThanOrEqual(1);
    }
  });

  it('I-P2: every resolved plan target sends only to the profile resource origin', async () => {
    const { result } = await loadTargets({
      a: planTarget(),
      b: planTarget({ baseUrl: 'https://api.openai.com/v1/alt', plan: { profile: 'chatgpt', account: 'b' } }),
    });
    for (const target of Object.values(result.settings.models.targets)) {
      if (target.adapter === 'fm' || !('plan' in target)) continue;
      expect(new URL(target.baseUrl ?? '').origin).toBe('https://api.openai.com');
    }
  });

  it('I-P3: credentialEnvNames and secretNames ignore plan targets', async () => {
    const { result } = await loadTargets({
      plan: planTarget(),
      env: { adapter: 'open-responses', provider: 'fake', model: 'm', baseUrl: 'https://example.com/v1', apiKeyEnv: 'KEY_ONE', capabilities: { contextWindow: 1000, maxOutputTokens: 100 } },
      secret: { adapter: 'open-responses', provider: 'fake', model: 'm', baseUrl: 'https://example.com/v1', apiKeySecret: 'key-two', capabilities: { contextWindow: 1000, maxOutputTokens: 100 } },
    });
    expect(credentialEnvNames(result.settings)).toEqual(['KEY_ONE']);
    expect(secretNames(result.settings)).toEqual(['key-two']);
  });

  it('lists the account labels that plan targets pin, once and sorted', async () => {
    const { result } = await loadTargets({
      a: planTarget({ plan: { profile: 'chatgpt', account: 'work' } }),
      b: planTarget({ plan: { profile: 'chatgpt', account: 'home' } }),
      c: planTarget({ plan: { profile: 'chatgpt', account: 'work' } }),
      d: planTarget(),
    });
    expect(planAccountNames(result.settings)).toEqual([{ profile: 'chatgpt', account: 'home' }, { profile: 'chatgpt', account: 'work' }]);
  });
});

describe('capabilities an open-responses target can declare for a route', () => {
  const open = (capabilities: Record<string, unknown>) => ({
    adapter: 'open-responses',
    provider: 'fake',
    model: 'm',
    baseUrl: 'https://example.com/v1',
    capabilities: { contextWindow: 100000, maxOutputTokens: 4000, ...capabilities },
  });

  it.each(['max_output_tokens', 'none'])('accepts outputBoundField %s', async (field) => {
    const { result } = await loadTargets({ t: open({ outputBoundField: field }) });
    expect(result.settings.models.targets['t']).toMatchObject({ capabilities: { outputBoundField: field } });
  });

  it.each(['max_tokens', 'max_completion_tokens'])('refuses outputBoundField %s, which the open-responses wire does not carry', async (field) => {
    await expectRejected({ targets: { t: open({ outputBoundField: field }) } }, /outputBoundField/);
  });

  it('accepts systemRole, toolPlacement and inputKinds', async () => {
    const { result } = await loadTargets({ t: open({ systemRole: 'developer', toolPlacement: 'additional_tools', inputKinds: { content: ['text'], tools: ['function'] } }) });
    expect(result.settings.models.targets['t']).toMatchObject({
      capabilities: { systemRole: 'developer', toolPlacement: 'additional_tools', inputKinds: { content: ['text'], tools: ['function'] } },
    });
  });

  it('refuses a systemRole, a toolPlacement or an input kind it does not know', async () => {
    await expectRejected({ targets: { t: open({ systemRole: 'root' }) } }, /systemRole/);
    await expectRejected({ targets: { t: open({ toolPlacement: 'namespace' }) } }, /toolPlacement/);
    await expectRejected({ targets: { t: open({ inputKinds: { content: ['smell'], tools: [] } }) } }, /inputKinds/);
  });

  it('refuses unboundedOutputTokens, which is derived and never declared', async () => {
    await expectRejected({ targets: { t: open({ unboundedOutputTokens: 4000 }) } }, /unboundedOutputTokens/);
  });

  it('refuses outputBoundField none on a chat-completions target, where the probe measures it', async () => {
    await expectRejected(
      { targets: { t: { adapter: 'chat-completions', provider: 'fake', model: 'm', baseUrl: 'https://example.com/v1', capabilities: { contextWindow: 1000, maxOutputTokens: 100, outputBoundField: 'none' } } } },
      /outputBoundField/,
    );
  });
});

describe('the input-room rule for an alias that holds a target with no output bound', () => {
  const unbounded = (contextWindow: number, maxOutputTokens: number) =>
    planTarget({ capabilities: { contextWindow, maxOutputTokens } });

  const metered = (contextWindow: number, maxOutputTokens: number) => ({
    adapter: 'open-responses',
    provider: 'fake',
    model: 'm',
    baseUrl: 'https://example.com/v1',
    capabilities: { contextWindow, maxOutputTokens },
  });

  it('accepts a window that leaves a quarter for input after the whole output and the margin', async () => {
    const { result } = await load({ targets: { gpt: unbounded(200000, 32000) }, aliases: { default: 'gpt' } });
    expect(result.settings.models.aliases['default']).toBe('gpt');
  });

  it('refuses an alias whose window cannot hold the largest output, naming the alias and the numbers', async () => {
    await expectRejected(
      { targets: { gpt: unbounded(100000, 90000) }, aliases: { default: 'gpt' } },
      /models\.aliases\.default/,
      /100000/,
      /90000/,
      /2000/,
      /25000/,
    );
  });

  it('counts the largest output of every member, because any member can serve the request', async () => {
    await expectRejected(
      { targets: { gpt: unbounded(200000, 8000), big: metered(200000, 150000) }, aliases: { default: ['gpt', 'big'] } },
      /models\.aliases\.default/,
      /150000/,
    );
  });

  it('uses the smallest window of the members', async () => {
    await expectRejected(
      { targets: { gpt: unbounded(200000, 16000), small: metered(20000, 4000) }, aliases: { default: ['gpt', 'small'] } },
      /models\.aliases\.default/,
      /20000/,
      /16000/,
    );
  });

  it('does not apply to an alias whose members all carry a bound', async () => {
    const { result } = await load({ targets: { a: metered(20000, 19000) }, aliases: { default: 'a' } });
    expect(result.settings.models.aliases['default']).toBe('a');
  });

  it('does not judge an alias while a member has no declared number', async () => {
    const { result } = await load({ targets: { gpt: planTarget(), big: metered(200000, 150000) }, aliases: { default: ['gpt', 'big'] } });
    expect(result.settings.models.aliases['default']).toEqual(['gpt', 'big']);
  });
});
