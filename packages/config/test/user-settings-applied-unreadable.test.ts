import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUserSettingsCache, noKeptRecords, writeAppliedRecord } from '@momonga/config';
import { systemRandom } from '@momonga/foundation';

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
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-applied-bad-')));
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
  return { home, record, write };
};

const UNREADABLE: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'truncated', text: '{"seq": 2, "settings": {"models": ' },
  { label: 'empty', text: '' },
  { label: 'wrong format', text: JSON.stringify(settingsWithModel('raw-format')) },
];

describe('S7: an unreadable applied record is no newer copy (design-settings-live 15.6, CorruptRecord)', () => {
  for (const { label, text } of UNREADABLE) {
    it(`a ${label} record with an invalid file: loadOrKeep returns the own copy and warns once per record identity`, async () => {
      const tree = makeTree();
      fs.writeFileSync(tree.record, `${JSON.stringify({ seq: 1, settings: settingsWithModel('a') })}\n`, { mode: 0o600 });
      tree.write(JSON.stringify(settingsWithModel('a')));
      const warnings: string[] = [];
      const cache = createUserSettingsCache({ home: tree.home, onWarning: (message) => warnings.push(message), keptRecords: noKeptRecords, appliedRecord: tree.record });
      expect(servedModelOf((await cache.loadOrKeep(NOT_ABORTED)).settings)).toBe('a');
      fs.writeFileSync(tree.record, text, { mode: 0o600 });
      tree.write('{ "models": ');
      const before = warnings.length;
      await expect(cache.loadOrKeep(NOT_ABORTED)).resolves.toBeDefined();
      expect(servedModelOf((await cache.loadOrKeep(NOT_ABORTED)).settings)).toBe('a');
      expect(warnings.slice(before).filter((message) => message.includes(tree.record))).toHaveLength(1);
    });

    it(`a ${label} record is healed by the supervisor's next write, even with unchanged content`, async () => {
      const tree = makeTree();
      tree.write(JSON.stringify(settingsWithModel('c')));
      fs.writeFileSync(tree.record, text, { mode: 0o600 });
      await expect(writeAppliedRecord(tree.home, tree.record, undefined, { signal: NOT_ABORTED, random: systemRandom })).resolves.toBeDefined();
      expect(JSON.parse(fs.readFileSync(tree.record, 'utf8'))).toMatchObject({ seq: expect.any(Number), settings: settingsWithModel('c') });
    });
  }
});
