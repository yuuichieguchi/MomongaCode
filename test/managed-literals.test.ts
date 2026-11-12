import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');

const DESCRIPTION_FILE = path.join('packages', 'protocol', 'src', 'managed-servers.ts');
const TEST_FIXTURE_SOURCES = path.join('packages', 'testkit', 'src') + path.sep;

const sourceFilesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });

const productSources = (): string[] =>
  fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(packagesDir, entry.name, 'src')))
    .flatMap((entry) => sourceFilesUnder(path.join(packagesDir, entry.name, 'src')))
    .map((file) => path.relative(root, file))
    .filter((file) => file !== DESCRIPTION_FILE && !file.startsWith(TEST_FIXTURE_SOURCES));

const literalOf = (id: string): RegExp => new RegExp(`(['"\`])${id}\\1`);

const filesWithLiteral = (id: string): string[] => productSources().filter((file) => literalOf(id).test(fs.readFileSync(path.join(root, file), 'utf8')));

describe('no product code branches on a managed server id (design-managed-servers section 3.1, AT1)', () => {
  it('finds the literal fm only in the description file', () => {
    expect(filesWithLiteral('fm')).toEqual([]);
  });

  it('keeps the description file, so the scan above has the one allowed place', () => {
    expect(fs.existsSync(path.join(root, DESCRIPTION_FILE))).toBe(true);
  });
});
