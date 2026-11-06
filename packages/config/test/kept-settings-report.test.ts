import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, createKeptSettings, diskKeptRecords, keptSettingsDirectory } from '@momonga/config';
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

describe('a kept copy is parsed by the settings parse rules', () => {
  it('a kept copy nested deeper than the settings limit is refused as no kept copy and reported once', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-depth-'));
    const directory = keptSettingsDirectory(home);
    fs.mkdirSync(directory, { recursive: true });
    const deep = `${'['.repeat(MAX_JSON_DEPTH + 1)}${']'.repeat(MAX_JSON_DEPTH + 1)}`;
    const record = path.join(directory, `${sha256Hex(FILE)}.json`);
    fs.writeFileSync(record, `{"file":${JSON.stringify(FILE)},"read":{"found":true,"value":${deep}}}`);
    const lines: string[] = [];
    const kept = createKeptSettings({ records: diskKeptRecords(nodeFileSystemSync, directory), onWarning: (line) => lines.push(line) });

    expect(kept.recall(FILE)).toBeUndefined();
    expect(kept.recall(FILE)).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`could not keep the last good copy of ${FILE}: ${record}`);
    expect(lines[0]).toContain(String(MAX_JSON_DEPTH));
    fs.rmSync(home, { recursive: true, force: true });
  });
});
