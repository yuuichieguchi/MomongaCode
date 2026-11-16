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
  { file: 'foundation/src/file-rules.ts', rows: 'B7', sites: 1, owner: 'HB10b final deletion of HOST_RULE_ENFORCEMENT' },
  { file: 'foundation/src/platform/process-inspector.ts', rows: 'B1', sites: 5, owner: 'HB10b' },
  { file: 'foundation/src/platform/privacy.ts', rows: 'B16', sites: 4, owner: 'wave 3, after hb0 and a84' },
  { file: 'tools/src/node-ports.ts', rows: 'B4 B6', sites: 2, owner: 'HB10a B4 after the hb0 and a84 check; HB10e' },
  { file: 'tools/src/builtins/bash.ts', rows: 'B4 B5', sites: 1, owner: 'HB10e' },
  { file: 'config/src/setting-defaults.ts', rows: 'B8', sites: 1, owner: 'HB10c' },
  { file: 'runtime/src/process/start-runtime-process.ts', rows: 'B9 B15', sites: 1, owner: 'HB10c' },
  { file: 'foundation/src/socket-path.ts', rows: 'B15', sites: 1, owner: 'config: endpointFormsOfPlatform reads process.platform by default and config/src/models.ts:122 calls it with no platform from its ports' },
  { file: 'cli/src/node-ports.ts', rows: 'CliPorts.platform', sites: 6, owner: 'not classified by the HB10 table' },
  { file: 'cli/src/run/resolve-session.ts', rows: 'not classified by the HB10 table', sites: 1, owner: 'cli-commands: the session-in-other-folder message takes the host platform from the cli ports, as the rest of the cli does' },
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

const HOST_RULE_READERS_OWNED_ELSEWHERE: Readonly<Record<string, string>> = {
  'runtime/test/service/helpers.ts': 'fp/interactions and a1de',
  'runtime/test/worker/harness.ts': 'fp/interactions',
  'runtime/test/memory/reflection-git.test.ts': 'a1de',
  'runtime/test/process/policy.test.ts': 'a84',
  'tools/test/real-workspace.ts': 'a84',
  'tools/test/history/history-tools.test.ts': 'toolfit',
};

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

describe('HOST_RULE_ENFORCEMENT readers (B7)', () => {
  it('is read by no test file except those owned by another branch; every other test states its sandbox kind through ruleEnforcementOf', () => {
    const readers = fs
      .readdirSync(packagesDir)
      .filter((name) => fs.existsSync(path.join(packagesDir, name, 'test')))
      .flatMap((name) => testFiles(path.join(packagesDir, name, 'test')))
      .filter((file) => fs.readFileSync(file, 'utf8').includes('HOST_RULE_ENFORCEMENT'))
      .map((file) => path.relative(packagesDir, file).split(path.sep).join('/'))
      .filter((file) => !(file in HOST_RULE_READERS_OWNED_ELSEWHERE))
      .sort();
    expect(readers).toEqual([]);
  });

  it('is read by no product source file', () => {
    const readers = fs
      .readdirSync(packagesDir)
      .filter((name) => fs.existsSync(path.join(packagesDir, name, 'src')))
      .flatMap((name) => sourceFiles(path.join(packagesDir, name, 'src')))
      .filter((file) => !file.endsWith(path.join('foundation', 'src', 'file-rules.ts')) && !file.endsWith(path.join('foundation', 'src', 'index.ts')))
      .filter((file) => fs.readFileSync(file, 'utf8').includes('HOST_RULE_ENFORCEMENT'))
      .map((file) => path.relative(packagesDir, file));
    expect(readers).toEqual([]);
  });
});
