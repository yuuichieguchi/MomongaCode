import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');
const SCANNED_ROOTS = ['packages', 'e2e', 'scripts', 'test'] as const;
const RAW_TEMP_CALL = /(?:\b(?:fs|os|promises)\.|(?<![.\w]))(mkdtemp(?:Sync|Disposable|DisposableSync)?|tmpdir)\s*\(/g;

const ALLOWANCES: Readonly<Record<string, string>> = {
  'e2e/support/home.ts': 'the e2e home creator: a home under the private per-user root, which the e2e teardown sweeps by its run prefix',
  'packages/testkit/test/temp-dir-creator.test.ts': 'it pins the base of the testkit creator to the system temporary folder',
  'test/temp-directory-single-creator.test.ts': 'its planted source names each raw form, to show the scan finds it',
  'test/leak-guard.test.ts': 'it proves that the leak guard records a temporary entry made by each raw form of mkdtemp, so it must call each form',
};

const isTestCode = (relative: string): boolean => {
  if (relative.startsWith('packages/')) return /^packages\/[^/]+\/test\//.test(relative);
  if (relative.startsWith('scripts/')) return relative.endsWith('.test.ts') || relative.startsWith('scripts/support/');
  return true;
};

const filesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return /\.(ts|tsx|mts)$/.test(entry.name) ? [full] : [];
  });

const rawTempCallsOf = (source: string): string[] => [...source.matchAll(RAW_TEMP_CALL)].map((match) => match[1] ?? '');

const scannedFiles = (): string[] =>
  SCANNED_ROOTS.flatMap((top) => filesUnder(path.join(root, top)))
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter(isTestCode);

describe('every temporary folder of a test comes from the one testkit creator', () => {
  it('no test file, test support or e2e file calls mkdtemp or os.tmpdir() itself', () => {
    const raw = scannedFiles()
      .filter((file) => ALLOWANCES[file] === undefined)
      .flatMap((file) => rawTempCallsOf(fs.readFileSync(path.join(root, file), 'utf8')).map((call) => `${file}: ${call}`));
    expect(raw).toEqual([]);
  });

  it('every allowance names a file that still holds a raw call', () => {
    const stale = Object.keys(ALLOWANCES).filter((file) => rawTempCallsOf(fs.readFileSync(path.join(root, file), 'utf8')).length === 0);
    expect(stale).toEqual([]);
  });

  it('finds each raw form in a planted source', () => {
    expect(rawTempCallsOf("fs.mkdtempSync(path.join(os.tmpdir(), 'x-')); await mkdtemp('y'); fs.promises.mkdtemp('z'); nodeFileSystem.mkdtemp('port');")).toEqual(['mkdtempSync', 'tmpdir', 'mkdtemp', 'mkdtemp']);
  });
});
