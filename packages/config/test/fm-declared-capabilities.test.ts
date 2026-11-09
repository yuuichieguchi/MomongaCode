import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';

const loadWith = async (target: Record<string, unknown>) => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fm-caps-'));
  fs.mkdirSync(path.join(home, '.momonga'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.momonga', 'settings.json'), JSON.stringify({ models: { targets: { local: target }, aliases: { default: 'local' } } }), { mode: 0o600 });
  try {
    return await loadUserSettings({ home });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

describe('an fm target that declares the capabilities a probe would measure', () => {
  it('keeps the declared context window and output bound', async () => {
    const { settings } = await loadWith({ adapter: 'fm', toolCalling: 'native', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } });

    expect(settings.models.targets['local']).toMatchObject({ capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } });
  });

  it.each([
    ['a context window without an output bound', { contextWindow: 8192 }],
    ['an output bound without a context window', { maxOutputTokens: 1024 }],
    ['an unknown capability', { contextWindow: 8192, maxOutputTokens: 1024, streaming: true }],
  ])('refuses %s', async (_label, capabilities) => {
    await expect(loadWith({ adapter: 'fm', capabilities })).rejects.toThrow(/capabilities/);
  });
});
