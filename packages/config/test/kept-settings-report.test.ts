import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, UnreadableKeptCopyError, createKeptSettings, diskKeptRecords, keptSettingsDirectory } from '@momonga/config';
import { MAX_JSON_DEPTH, nodeFileSystemSync, sha256Hex } from '@momonga/foundation';
import type { KeptRecords } from '@momonga/config';

const FILE = '/home/user/.momonga/settings.json';

describe('one report rule decides every kept-copy line, once per file and reason', () => {
  it('a write failure and an invalid file are each reported once, and each is cleared by its own success', () => {
    const lines: string[] = [];
    let failure: string | undefined = 'ENOSPC: no space left on device';
    const records: KeptRecords = {
      load: () => undefined,
      save: () => {
        if (failure !== undefined) throw new Error(failure);
      },
    };
    const kept = createKeptSettings({ records, onWarning: (line) => lines.push(line) });
    const invalid = new ConfigError(`${FILE}: invalid JSON at line 1 column 2`);

    kept.remember(FILE, { found: true, value: { a: 1 } });
    kept.remember(FILE, { found: true, value: { a: 2 } });
    kept.report(FILE, { kind: 'invalid', error: invalid, identity: 'k' });
    kept.report(FILE, { kind: 'invalid', error: invalid, identity: 'k' });
    expect(lines).toEqual([`could not keep the last good copy of ${FILE}: ENOSPC: no space left on device`, `settings file is invalid: ${invalid.message}`]);

    failure = undefined;
    kept.remember(FILE, { found: true, value: { a: 3 } });
    failure = 'ENOSPC: no space left on device';
    kept.remember(FILE, { found: true, value: { a: 4 } });
    kept.report(FILE, { kind: 'invalid', error: invalid, identity: 'k' });
    expect(lines).toHaveLength(4);
  });
});

const unusableLines = (content: string): { lines: string[]; record: string; first: unknown; second: unknown } => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-unusable-'));
  const directory = keptSettingsDirectory(home);
  fs.mkdirSync(directory, { recursive: true });
  const record = path.join(directory, `${sha256Hex(FILE)}.json`);
  fs.writeFileSync(record, content);
  const lines: string[] = [];
  const kept = createKeptSettings({ records: diskKeptRecords(nodeFileSystemSync, directory), onWarning: (line) => lines.push(line) });
  const first = kept.recall(FILE);
  const second = kept.recall(FILE);
  fs.rmSync(home, { recursive: true, force: true });
  return { lines, record, first, second };
};

describe('one rule decides whether a stored kept copy is usable', () => {
  it('a kept copy nested deeper than the settings limit is ignored and reported once', () => {
    const deep = `${'['.repeat(MAX_JSON_DEPTH + 1)}${']'.repeat(MAX_JSON_DEPTH + 1)}`;
    const { lines, record, first, second } = unusableLines(`{"file":${JSON.stringify(FILE)},"read":{"found":true,"value":${deep}}}`);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`the last good copy of ${FILE} is unusable and was ignored: ${record}: `);
    expect(lines[0]).toContain(String(MAX_JSON_DEPTH));
  });

  it('a kept copy of the wrong shape is ignored and reported once', () => {
    const { lines, record, first, second } = unusableLines(`{"file":${JSON.stringify(FILE)},"read":{"found":"yes"}}`);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(lines).toEqual([`the last good copy of ${FILE} is unusable and was ignored: ${record}: not a kept copy of ${FILE}`]);
  });

  it('a kept copy naming a different file is ignored and reported once', () => {
    const { lines, record, first, second } = unusableLines(`{"file":"/elsewhere/settings.json","read":{"found":false}}`);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(lines).toEqual([`the last good copy of ${FILE} is unusable and was ignored: ${record}: not a kept copy of ${FILE}`]);
  });

  it('a fresh copy written after a valid read clears the unusable report', () => {
    const lines: string[] = [];
    const reason = '/state/k.json: not a kept copy';
    const records: KeptRecords = {
      load: () => {
        throw new UnreadableKeptCopyError(reason);
      },
      save: () => undefined,
    };
    const kept = createKeptSettings({ records, onWarning: (line) => lines.push(line) });
    expect(kept.recall(FILE)).toBeUndefined();
    kept.report(FILE, { kind: 'unusable', reason });
    expect(lines).toHaveLength(1);
    kept.remember(FILE, { found: true, value: { a: 1 } });
    kept.report(FILE, { kind: 'unusable', reason });
    expect(lines).toEqual([
      `the last good copy of ${FILE} is unusable and was ignored: ${reason}`,
      `the last good copy of ${FILE} is unusable and was ignored: ${reason}`,
    ]);
  });
});
