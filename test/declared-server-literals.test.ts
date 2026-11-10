import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');

const DESCRIPTION_FILE = path.join('packages', 'protocol', 'src', 'managed-servers.ts');
const TEST_FIXTURE_SOURCES = path.join('packages', 'testkit', 'src') + path.sep;

const DECLARED_TEST_IDS = ['mine', 'loom', 'bench', 'kiln'];

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

describe('no product code names a declared server id or fm outside the built-in description file (design-managed-servers 19.8, AT1; R-S19-19)', () => {
  it.each(['fm', ...DECLARED_TEST_IDS])('finds the literal %s in no product source', (id) => {
    expect(filesWithLiteral(id)).toEqual([]);
  });
});
