import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');

const OLD_KEY_SENTENCES_FILE = 'packages/config/src/settings.ts';

type Remaining = { file: string; removedBy: 'N1' | 'N2' | 'N3a' | 'N3b' | 'N4' };

const REMAINING: readonly Remaining[] = [];

const filesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.isFile() ? [full] : [];
  });

const filesNamingTheOldKeys = (): string[] =>
  fs
    .readdirSync(packagesDir)
    .filter((name) => fs.existsSync(path.join(packagesDir, name, 'src')))
    .flatMap((name) => filesUnder(path.join(packagesDir, name, 'src')))
    .filter((file) => /models\.targets|models\.aliases/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter((file) => file !== OLD_KEY_SENTENCES_FILE)
    .sort();

describe('adoption of the new settings shape', () => {
  it('the source files that still name models.targets or models.aliases are the ones listed for a later increment, and none when the list is empty', () => {
    expect(filesNamingTheOldKeys()).toEqual(REMAINING.map((entry) => entry.file).sort());
  });
});
