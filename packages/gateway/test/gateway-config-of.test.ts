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

describe('gatewayConfigOf provider names', () => {
  it('names an fm target apple, a chat-completions target by its provider setting, and otherwise by the OpenAI format flavor', async () => {
    const targets = await targetsFor({
      targets: {
        onDevice: { adapter: 'fm' },
        hosted: { adapter: 'chat-completions', model: 'm', baseUrl: 'https://api.example.com/v1', provider: 'acme', capabilities: CAPABILITIES },
        compatible: { adapter: 'chat-completions', model: 'm', baseUrl: 'https://api.example.com/v1', capabilities: CAPABILITIES },
      },
      aliases: { default: 'onDevice' },
    });
    expect(Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, target.provider]))).toEqual({
      onDevice: 'apple',
      hosted: 'acme',
      compatible: 'openai',
    });
  });

  it('names the implicit default target apple', async () => {
    const targets = await targetsFor({});
    expect(Object.values(targets).map((target) => target.provider)).toEqual(['apple']);
  });
});
