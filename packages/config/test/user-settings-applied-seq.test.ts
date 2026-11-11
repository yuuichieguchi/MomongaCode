import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUserSettingsCache, noKeptRecords, writeAppliedRecord } from '@momonga/config';
import type { UserSettingsCacheOptions } from '@momonga/config';
import { systemRandom } from '@momonga/foundation';
import { testKernelLock } from '@momonga/testkit';

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

const makeTree = () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-applied-seq-')));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.momonga');
  const dir = path.join(root, 'run', 'g1');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = path.join(dir, 'settings-applied.json');
  let writes = 0;
  const write = (text: string): void => {
    writes += 1;
    const temporary = path.join(root, `.s-${writes}.tmp`);
    fs.writeFileSync(temporary, `${text}${' '.repeat(writes)}`, { mode: 0o600 });
    fs.renameSync(temporary, path.join(root, 'settings.json'));
  };
  const writeRecord = (seq: number, settings: unknown): void => {
    fs.writeFileSync(record, `${JSON.stringify({ seq, settings })}\n`, { mode: 0o600 });
  };
  return { home, record, write, writeRecord };
};

const cacheOf = (home: string, appliedRecord: string) =>
  createUserSettingsCache({ home, onWarning: () => undefined, keptRecords: noKeptRecords, appliedRecord } as UserSettingsCacheOptions);

const modelOf = async (cache: ReturnType<typeof cacheOf>): Promise<string | undefined> => servedModelOf((await cache.loadOrKeep(NOT_ABORTED)).settings);

describe('S7: the applied record is ordered by seq (design-settings-live 15.1, NoRollbackAfterApply)', () => {
  it('a record at seq 2 wins over an own copy noted at seq 1', async () => {
    const tree = makeTree();
    tree.writeRecord(1, settingsWithModel('a'));
    tree.write(JSON.stringify(settingsWithModel('a')));
    const cache = cacheOf(tree.home, tree.record);
    expect(await modelOf(cache)).toBe('a');
    tree.writeRecord(2, settingsWithModel('b'));
    tree.write('{ "models": ');
    expect(await modelOf(cache)).toBe('b');
  });

  it('a process that read c validly while the record was at seq 2 keeps c when the file breaks', async () => {
    const tree = makeTree();
    tree.writeRecord(2, settingsWithModel('b'));
    tree.write(JSON.stringify(settingsWithModel('c')));
    const cache = cacheOf(tree.home, tree.record);
    expect(await modelOf(cache)).toBe('c');
    tree.write('{ "models": ');
    expect(await modelOf(cache)).toBe('c');
  });

  it('an invalid file leaves the record byte-identical: no write and no deletion', async () => {
    const tree = makeTree();
    tree.writeRecord(3, settingsWithModel('b'));
    const before = fs.readFileSync(tree.record);
    tree.write('{ "models": ');
    const cache = cacheOf(tree.home, tree.record);
    expect(await modelOf(cache)).toBe('b');
    expect(await writeAppliedRecord(tree.home, tree.record, undefined, { signal: NOT_ABORTED, random: systemRandom, lock: testKernelLock() })).toEqual({ kind: 'invalid' });
    expect(fs.readFileSync(tree.record).equals(before)).toBe(true);
  });
});
