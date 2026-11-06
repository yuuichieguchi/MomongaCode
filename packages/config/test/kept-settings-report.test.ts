import { describe, expect, it } from 'vitest';
import { ConfigError, createKeptSettings } from '@momonga/config';
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
