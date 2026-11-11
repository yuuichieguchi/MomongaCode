import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { connectionOf, modelOf } from './helpers.ts';

const loadWith = async (target: Record<string, unknown>) => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fm-caps-'));
  fs.mkdirSync(path.join(home, '.momonga'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.momonga', 'settings.json'), JSON.stringify({ models: { connections: [connectionOf('local', target)] } }), { mode: 0o600 });
  try {
    return await loadUserSettings({ home, signal: new AbortController().signal });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

describe('an fm target that declares the capabilities a probe would measure', () => {
  it('keeps the declared context window and output bound', async () => {
    const { settings } = await loadWith({ adapter: 'managed', server: 'fm', toolCalling: 'native', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } });

    expect(modelOf(settings, 'local')).toMatchObject({ capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } });
  });

  it.each([
    ['a context window without an output bound', { contextWindow: 8192 }],
    ['an output bound without a context window', { maxOutputTokens: 1024 }],
    ['an unknown capability', { contextWindow: 8192, maxOutputTokens: 1024, streaming: true }],
  ])('refuses %s', async (_label, capabilities) => {
    await expect(loadWith({ adapter: 'managed', server: 'fm', capabilities })).rejects.toThrow(/capabilities/);
  });
});
