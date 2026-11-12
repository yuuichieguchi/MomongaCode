import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');
const HELPER = path.join(packagesDir, 'gateway', 'src', 'adapters', 'shared', 'json-reply.ts');

const sourceFilesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFilesUnder(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

const callerFiles = (): string[] => [
  ...sourceFilesUnder(path.join(packagesDir, 'runtime', 'src')),
  ...sourceFilesUnder(path.join(packagesDir, 'eval', 'src')),
  path.join(packagesDir, 'cli', 'src', 'commands', 'context.ts'),
  path.join(packagesDir, 'cli', 'src', 'commands', 'auto-mode.ts'),
];

const adapterFiles = (): string[] => sourceFilesUnder(path.join(packagesDir, 'gateway', 'src', 'adapters')).filter((file) => file !== HELPER);

const offenders = (files: readonly string[], pattern: RegExp): string[] =>
  files.filter((file) => pattern.test(fs.readFileSync(file, 'utf8'))).map((file) => path.relative(root, file));

describe('a JSON reply is decided by one rule', () => {
  it('has the helper the adapters share', () => {
    expect(fs.existsSync(HELPER)).toBe(true);
  });

  it('lets no caller read structuredOutput or the deleted predicate to decide whether a call may run', () => {
    expect(offenders(callerFiles(), /structuredOutput|requireStructuredOutput/)).toEqual([]);
  });

  it('lets no adapter outside the helper read structuredOutput or the request format to choose the wire form', () => {
    expect(offenders(adapterFiles(), /structuredOutput|text\??\.format/)).toEqual([]);
  });

  it('keeps no second JSON-shape check beside defineProductSchema in the three callers', () => {
    const callers = [
      path.join(packagesDir, 'runtime', 'src', 'memory', 'reflection.ts'),
      path.join(packagesDir, 'runtime', 'src', 'memory', 'reflection-reply.ts'),
      path.join(packagesDir, 'runtime', 'src', 'worker', 'auto-classifier.ts'),
      path.join(packagesDir, 'runtime', 'src', 'worker', 'classifier-verdict.ts'),
      path.join(packagesDir, 'eval', 'src', 'guideline-prompts.ts'),
    ].filter((file) => fs.existsSync(file));
    expect(offenders(callers, /parseReflectionReply|parseClassifierVerdict|parseOutsideJson/)).toEqual([]);
    expect(fs.existsSync(path.join(packagesDir, 'runtime', 'src', 'worker', 'classifier-verdict.ts'))).toBe(false);
  });

  it('keeps the predicate out of the protocol', () => {
    expect(offenders([path.join(packagesDir, 'protocol', 'src', 'capabilities.ts'), path.join(packagesDir, 'protocol', 'src', 'index.ts')], /requireStructuredOutput/)).toEqual([]);
  });
});
