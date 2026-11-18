import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { adapterFilesOf } from './support/adapters.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');

const PLATFORM_NAME_TOKEN = /process\.platform|\bos\.platform\(\)|(?<![.\w])platform\(\)|case\s+['"](?:aix|android|cygwin|darwin|freebsd|haiku|linux|netbsd|openbsd|sunos|win32)['"]/;

type BurnDown = { file: string; rows: string; sites: number; owner: string };

const PACKAGE_PREFIX = 'packages/';

const KEPT_FILES: readonly string[] = Object.keys(adapterFilesOf('platform-name')).map((file) => file.slice(PACKAGE_PREFIX.length));

const BURN_DOWN: readonly BurnDown[] = [
  { file: 'foundation/src/platform/privacy.ts', rows: 'B16', sites: 2, owner: 'foundation: the mode and owner checks still skip on win32 by name; the probe of a 0600 file and its stat replaces them (T-HB10-3)' },
  { file: 'tools/src/node-ports.ts', rows: 'B4 B6', sites: 2, owner: 'HB10a B4 after the hb0 and a84 check; HB10e' },
  { file: 'tools/src/builtins/bash.ts', rows: 'B4 B5', sites: 1, owner: 'HB10e' },
  { file: 'runtime/src/process/start-runtime-process.ts', rows: 'B9 B15', sites: 1, owner: 'HB10c' },
  { file: 'cli/src/node-ports.ts', rows: 'CliPorts.platform', sites: 6, owner: 'not classified by the HB10 table' },
];

const EXCLUDED_PACKAGES = new Set(['testkit']);

const sourceFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

const PLATFORM_NAME_SITE = new RegExp(PLATFORM_NAME_TOKEN.source, 'g');

const callSitesByFile = (): Record<string, number> =>
  Object.fromEntries(
    fs
      .readdirSync(packagesDir)
      .filter((name) => !EXCLUDED_PACKAGES.has(name) && fs.existsSync(path.join(packagesDir, name, 'src')))
      .flatMap((name) => sourceFiles(path.join(packagesDir, name, 'src')))
      .map((file) => [path.relative(packagesDir, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8').match(PLATFORM_NAME_SITE)?.length ?? 0] as const)
      .filter(([, sites]) => sites > 0),
  );

const filesWithPlatformNames = (): string[] =>
  fs
    .readdirSync(packagesDir)
    .filter((name) => !EXCLUDED_PACKAGES.has(name) && fs.existsSync(path.join(packagesDir, name, 'src')))
    .flatMap((name) => sourceFiles(path.join(packagesDir, name, 'src')))
    .filter((file) => PLATFORM_NAME_TOKEN.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(packagesDir, file).split(path.sep).join('/'))
    .sort();

const testFiles = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });


describe('platform-name branches (I-N1)', () => {
  it('names a platform only in files kept with a reason or listed for burn-down with an owner', () => {
    const listed = new Set([...KEPT_FILES, ...BURN_DOWN.map((entry) => entry.file)]);
    expect(filesWithPlatformNames().filter((file) => !listed.has(file))).toEqual([]);
  });

  it('lists for burn-down only files that still name a platform, so the list shrinks', () => {
    const present = new Set(filesWithPlatformNames());
    expect(BURN_DOWN.map((entry) => entry.file).filter((file) => !present.has(file))).toEqual([]);
  });

  it('holds every burn-down file to its count of call sites, so a new branch in a listed file is seen', () => {
    const present = callSitesByFile();
    expect(Object.fromEntries(BURN_DOWN.map((entry) => [entry.file, present[entry.file]]))).toEqual(Object.fromEntries(BURN_DOWN.map((entry) => [entry.file, entry.sites])));
  });

  it('lists no file twice', () => {
    const files = [...KEPT_FILES, ...BURN_DOWN.map((entry) => entry.file)];
    expect(files.length).toBe(new Set(files).size);
  });
});

describe('HOST_RULE_ENFORCEMENT is deleted (B7)', () => {
  it('is named by no source or test file: the rule enforcement follows the sandbox kind through ruleEnforcementOf', () => {
    const readers = fs
      .readdirSync(packagesDir)
      .flatMap((name) => ['src', 'test'].map((part) => path.join(packagesDir, name, part)).filter((directory) => fs.existsSync(directory)))
      .flatMap((directory) => testFiles(directory))
      .filter((file) => !file.endsWith('.generated.ts') && fs.readFileSync(file, 'utf8').includes('HOST_RULE_ENFORCEMENT'))
      .map((file) => path.relative(packagesDir, file).split(path.sep).join('/'))
      .sort();
    expect(readers).toEqual([]);
  });
});
