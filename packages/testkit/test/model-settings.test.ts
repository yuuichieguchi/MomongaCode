import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { momongaLayout } from '@momonga/foundation';
import { SCRIPTED_MODEL, modelSettings } from '@momonga/testkit';
import { createTempDir } from '../src/test-support.ts';

type LoadedModels = { models: ReadonlyMap<string, unknown>; start: string | undefined; chains: ReadonlyMap<string, readonly string[]> };

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const loaded = async (settings: unknown): Promise<LoadedModels> => {
  const home = createTempDir();
  homes.push(home);
  const file = momongaLayout(home, process.platform, process.env).settingsFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
  return (await loadUserSettings({ home, signal: new AbortController().signal })).settings.models as unknown as LoadedModels;
};

describe('modelSettings builds settings in the shape the product loader accepts', () => {
  it('the one-model object loads, and its only model and start model are SCRIPTED_MODEL', async () => {
    expect(SCRIPTED_MODEL).toBe('scripted/scripted-model');
    const settings = modelSettings();
    expect(settings.models.connections.map((connection) => connection.provider)).toEqual(['scripted']);
    const models = await loaded(settings);
    expect([...models.models.keys()]).toEqual([SCRIPTED_MODEL]);
    expect(models.start).toBe(SCRIPTED_MODEL);
    expect(models.chains.get(SCRIPTED_MODEL)).toEqual([SCRIPTED_MODEL]);
  });

  it('the two-model object loads with every provider written, the first model as the start model and the second as its fallback', async () => {
    const settings = modelSettings({ models: [{}, { provider: 'second', id: 'other-model' }], fallback: ['second/other-model'] });
    expect(settings.models.connections.map((connection) => connection.provider)).toEqual(['scripted', 'second']);
    const models = await loaded(settings);
    expect([...models.models.keys()]).toEqual([SCRIPTED_MODEL, 'second/other-model']);
    expect(models.start).toBe(SCRIPTED_MODEL);
    expect(models.chains.get(SCRIPTED_MODEL)).toEqual([SCRIPTED_MODEL, 'second/other-model']);
    expect(models.chains.get('second/other-model')).toEqual(['second/other-model']);
  });
});
