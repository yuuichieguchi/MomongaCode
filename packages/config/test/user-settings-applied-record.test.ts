import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUserSettingsCache, noKeptRecords } from '@momonga/config';
import type { UserSettingsCacheOptions } from '@momonga/config';
import { createTempDir } from '@momonga/testkit';

const NOT_ABORTED = new AbortController().signal;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const servedModelOf = (settings: { models: unknown }): string | undefined => [...(settings.models as { models: ReadonlyMap<string, { model: string }> }).models.values()][0]?.model;

const settingsWithModel = (model: string) => ({
  models: {
    connections: [{ adapter: 'chat-completions', provider: 'remote', baseUrl: 'https://api.example.com/v1', models: [{ id: model, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }] }],
  },
});

const makeHome = () => {
  const home = createTempDir();
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.momonga');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let writes = 0;
  const write = (text: string): void => {
    writes += 1;
    const temporary = path.join(root, `.s-${writes}.tmp`);
    fs.writeFileSync(temporary, `${text}${' '.repeat(writes)}`, { mode: 0o600 });
    fs.renameSync(temporary, path.join(root, 'settings.json'));
  };
  const recordFor = (generation: number, seq: number, settings: unknown): string => {
    const dir = path.join(root, 'run', `g${generation}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'settings-applied.json');
    fs.writeFileSync(file, JSON.stringify({ seq, settings }), { mode: 0o600 });
    return file;
  };
  return { home, write, recordFor, recordPathOf: (generation: number) => path.join(root, 'run', `g${generation}`, 'settings-applied.json') };
};

const cacheOf = (home: string, appliedRecord?: string) =>
  createUserSettingsCache({ env: process.env, home, onWarning: () => undefined, keptRecords: noKeptRecords, ...(appliedRecord === undefined ? {} : { appliedRecord }) } as UserSettingsCacheOptions);

const modelOf = async (cache: ReturnType<typeof cacheOf>): Promise<string | undefined> => servedModelOf((await cache.loadOrKeep(NOT_ABORTED)).settings);

describe('S7: the settings cache reads the applied record only on an invalid file (design-settings-live 15.1)', () => {
  it('a valid file is used directly even when the record holds other content', async () => {
    const tree = makeHome();
    tree.write(JSON.stringify(settingsWithModel('from-file')));
    const cache = cacheOf(tree.home, tree.recordFor(1, 1, settingsWithModel('from-record')));
    expect(await modelOf(cache)).toBe('from-file');
  });

  it('an invalid file with a record path given takes the record, even when this process never read that content', async () => {
    const tree = makeHome();
    tree.write(JSON.stringify(settingsWithModel('a')));
    const cache = cacheOf(tree.home, tree.recordFor(1, 1, settingsWithModel('a')));
    expect(await modelOf(cache)).toBe('a');
    tree.write(JSON.stringify(settingsWithModel('b')));
    tree.recordFor(1, 2, settingsWithModel('b'));
    tree.write('{ "models": ');
    expect(await modelOf(cache)).toBe('b');
  });

  it('with no record path the cache keeps its own last read content', async () => {
    const tree = makeHome();
    tree.write(JSON.stringify(settingsWithModel('a')));
    tree.recordFor(1, 2, settingsWithModel('b'));
    const cache = cacheOf(tree.home);
    expect(await modelOf(cache)).toBe('a');
    tree.write('{ "models": ');
    expect(await modelOf(cache)).toBe('a');
  });

  it('never reads the record of another generation', async () => {
    const tree = makeHome();
    tree.write(JSON.stringify(settingsWithModel('a')));
    tree.recordFor(1, 5, settingsWithModel('from-old-generation'));
    const cache = cacheOf(tree.home, tree.recordPathOf(2));
    expect(await modelOf(cache)).toBe('a');
    tree.recordFor(2, 1, settingsWithModel('b'));
    tree.write('{ "models": ');
    expect(await modelOf(cache)).toBe('b');
  });
});
