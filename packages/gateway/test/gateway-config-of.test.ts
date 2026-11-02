import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { gatewayConfigOf } from '@momonga/gateway';
import { makeDir } from './gateway-helpers.ts';

const targetsFor = async (models: Record<string, unknown>) => {
  const home = makeDir();
  fs.mkdirSync(path.join(home, '.momonga'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.momonga', 'settings.json'), JSON.stringify({ models }), { mode: 0o600 });
  const { settings } = await loadUserSettings({ home });
  return gatewayConfigOf(settings.models.targets, settings.models.aliases).models.targets;
};

const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };

describe('gatewayConfigOf billing', () => {
  it('declares an fm target local, a remote target metered unless the user declares it local', async () => {
    const targets = await targetsFor({
      targets: {
        onDevice: { adapter: 'fm' },
        hosted: { adapter: 'chat-completions', model: 'm', baseUrl: 'https://api.example.com/v1', provider: 'acme', capabilities: CAPABILITIES },
        selfHosted: { adapter: 'chat-completions', model: 'm', baseUrl: 'http://127.0.0.1:8000/v1', provider: 'vllm', billing: 'local', capabilities: CAPABILITIES },
      },
      aliases: { default: 'onDevice' },
    });
    expect(Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, target.billing]))).toEqual({
      onDevice: 'local',
      hosted: 'metered',
      selfHosted: 'local',
    });
  });
});

describe('gatewayConfigOf provider names', () => {
  it('names an fm target apple, and a chat-completions target by its provider setting', async () => {
    const targets = await targetsFor({
      targets: {
        onDevice: { adapter: 'fm' },
        hosted: { adapter: 'chat-completions', model: 'm', baseUrl: 'https://api.example.com/v1', provider: 'acme', capabilities: CAPABILITIES },
        local: { adapter: 'chat-completions', provider: 'vllm', model: 'm', baseUrl: 'http://127.0.0.1:8000/v1', capabilities: CAPABILITIES },
      },
      aliases: { default: 'onDevice' },
    });
    expect(Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, target.provider]))).toEqual({
      onDevice: 'apple',
      hosted: 'acme',
      local: 'vllm',
    });
  });

  it('names an anthropic target anthropic and and an open-responses target by its provider setting', async () => {
    const targets = await targetsFor({
      targets: {
        claude: { adapter: 'anthropic', model: 'm', baseUrl: 'https://api.example.com', apiKeyEnv: 'ANTHROPIC_API_KEY', capabilities: CAPABILITIES },
        relay: { adapter: 'open-responses', model: 'm', baseUrl: 'https://api.example.com/v1', provider: 'acme', capabilities: CAPABILITIES },
        ollama: { adapter: 'open-responses', provider: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:11434/v1', capabilities: CAPABILITIES },
      },
      aliases: { default: 'claude' },
    });
    expect(Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, target.provider]))).toEqual({
      claude: 'anthropic',
      relay: 'acme',
      ollama: 'ollama',
    });
  });

  it('names the implicit default target apple', async () => {
    const targets = await targetsFor({});
    expect(Object.values(targets).map((target) => target.provider)).toEqual(['apple']);
  });
});
