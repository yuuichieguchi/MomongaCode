import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { userSettingsChangeKey } from '@momonga/config';
import { withTempDir } from '@momonga/testkit';

const settingsFileOf = (home: string): string => path.join(home, '.momonga', 'settings.json');

const expectedKey = (file: string): string => {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
};

describe('config: userSettingsChangeKey', () => {
  it('is mtimeNs:size:ino of the user settings file', (context) => {
    const home = withTempDir(context);
    const file = settingsFileOf(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '{}\n', { mode: 0o600 });
    expect(userSettingsChangeKey(home)).toBe(expectedKey(file));
  });

  it('changes when the file is replaced', (context) => {
    const home = withTempDir(context);
    const file = settingsFileOf(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '{}\n', { mode: 0o600 });
    const before = userSettingsChangeKey(home);
    const replacement = `${file}.new`;
    fs.writeFileSync(replacement, '{ }\n', { mode: 0o600 });
    fs.renameSync(replacement, file);
    const after = userSettingsChangeKey(home);
    expect(after).toBe(expectedKey(file));
    expect(after).not.toBe(before);
  });

  it('is missing for a missing file', (context) => {
    expect(userSettingsChangeKey(withTempDir(context))).toBe('missing');
  });
});
