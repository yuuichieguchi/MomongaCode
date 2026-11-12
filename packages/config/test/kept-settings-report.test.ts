import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, UnreadableKeptCopyError, createKeptSettings, diskKeptRecords, keptSettingsDirectory } from '@momonga/config';
import { MAX_JSON_DEPTH, nodeFileSystem, sha256Hex, systemRandom } from '@momonga/foundation';
import type { KeptRecords } from '@momonga/config';
import { createTempDir, testKernelLock } from '@momonga/testkit';

const NOT_ABORTED = new AbortController().signal;

const FILE = '/home/user/.momonga/settings.json';

describe('one report rule decides every kept-copy line, once per file and reason', () => {
  it('a write failure and an invalid file are each reported once, and each is cleared by its own success', async () => {
    const lines: string[] = [];
    let failure: string | undefined = 'ENOSPC: no space left on device';
    const records: KeptRecords = {
      load: async () => undefined,
      save: async () => {
        if (failure !== undefined) throw new Error(failure);
      },
    };
    const kept = createKeptSettings({ records, onWarning: (line) => lines.push(line) });
    const invalid = new ConfigError(`${FILE}: invalid JSON at line 1 column 2`);

    await kept.remember(FILE, { found: true, value: { a: 1 } }, NOT_ABORTED);
    await kept.remember(FILE, { found: true, value: { a: 2 } }, NOT_ABORTED);
    kept.report(FILE, { kind: 'invalid', error: invalid, identity: 'k' });
    kept.report(FILE, { kind: 'invalid', error: invalid, identity: 'k' });
    expect(lines).toEqual([`could not keep the last good copy of ${FILE}: ENOSPC: no space left on device`, `settings file is invalid: ${invalid.message}`]);

    failure = undefined;
    await kept.remember(FILE, { found: true, value: { a: 3 } }, NOT_ABORTED);
    failure = 'ENOSPC: no space left on device';
    await kept.remember(FILE, { found: true, value: { a: 4 } }, NOT_ABORTED);
    kept.report(FILE, { kind: 'invalid', error: invalid, identity: 'k' });
    expect(lines).toHaveLength(4);
  });
});

const unusableLines = async (content: string): Promise<{ lines: string[]; record: string; first: unknown; second: unknown }> => {
  const home = createTempDir();
  const directory = keptSettingsDirectory(home);
  fs.mkdirSync(directory, { recursive: true });
  const record = path.join(directory, `${sha256Hex(FILE)}.json`);
  fs.writeFileSync(record, content, { mode: 0o600 });
  const lines: string[] = [];
  const kept = createKeptSettings({ records: diskKeptRecords(nodeFileSystem, systemRandom, directory, testKernelLock()), onWarning: (line) => lines.push(line) });
  const first = await kept.recall(FILE, NOT_ABORTED);
  const second = await kept.recall(FILE, NOT_ABORTED);
  fs.rmSync(home, { recursive: true, force: true });
  return { lines, record, first, second };
};

describe('one rule decides whether a stored kept copy is usable', () => {
  it('a kept copy nested deeper than the settings limit is ignored and reported once', async () => {
    const deep = `${'['.repeat(MAX_JSON_DEPTH + 1)}${']'.repeat(MAX_JSON_DEPTH + 1)}`;
    const { lines, record, first, second } = await unusableLines(`{"file":${JSON.stringify(FILE)},"read":{"found":true,"value":${deep}}}`);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`the last good copy of ${FILE} is unusable and was ignored: ${record}: `);
    expect(lines[0]).toContain(String(MAX_JSON_DEPTH));
  });

  it('a kept copy of the wrong shape is ignored and reported once', async () => {
    const { lines, record, first, second } = await unusableLines(`{"file":${JSON.stringify(FILE)},"read":{"found":"yes"}}`);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(lines).toEqual([`the last good copy of ${FILE} is unusable and was ignored: ${record}: not a kept copy of ${FILE}`]);
  });

  it('a kept copy naming a different file is ignored and reported once', async () => {
    const { lines, record, first, second } = await unusableLines(`{"file":"/elsewhere/settings.json","read":{"found":false}}`);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(lines).toEqual([`the last good copy of ${FILE} is unusable and was ignored: ${record}: not a kept copy of ${FILE}`]);
  });

  it('a fresh copy written after a valid read clears the unusable report', async () => {
    const lines: string[] = [];
    const reason = '/state/k.json: not a kept copy';
    const records: KeptRecords = {
      load: async () => {
        throw new UnreadableKeptCopyError(reason);
      },
      save: async () => undefined,
    };
    const kept = createKeptSettings({ records, onWarning: (line) => lines.push(line) });
    expect(await kept.recall(FILE, NOT_ABORTED)).toBeUndefined();
    kept.report(FILE, { kind: 'unusable', reason });
    expect(lines).toHaveLength(1);
    await kept.remember(FILE, { found: true, value: { a: 1 } }, NOT_ABORTED);
    kept.report(FILE, { kind: 'unusable', reason });
    expect(lines).toEqual([
      `the last good copy of ${FILE} is unusable and was ignored: ${reason}`,
      `the last good copy of ${FILE} is unusable and was ignored: ${reason}`,
    ]);
  });
});
