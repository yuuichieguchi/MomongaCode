import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const root = path.resolve(import.meta.dirname, '..');

const SLASH_MODELS = /(^|[\s`'"(])\/models(?![\w/-])/g;
const ROUTE_LITERAL = /^['"]\/models['"\\]$/;

const filesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(full);
    return /\.(ts|tsx|md)$/.test(entry.name) ? [full] : [];
  });

const productFiles = (): string[] => [
  ...fs.readdirSync(path.join(root, 'packages')).flatMap((name) => {
    const source = path.join(root, 'packages', name, 'src');
    return fs.existsSync(source) ? filesUnder(source) : [];
  }),
  ...filesUnder(path.join(root, 'docs')),
  ...filesUnder(path.join(root, 'site', 'docs')),
  path.join(root, 'README.md'),
];

const mentionsOf = (text: string): string[] =>
  [...text.matchAll(SLASH_MODELS)].flatMap((match) => {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const before = text.slice(start - 1, start);
    const after = text.slice(start + '/models'.length, start + '/models'.length + 1);
    return ROUTE_LITERAL.test(`${before}/models${after}`) ? [] : [text.slice(Math.max(0, start - 40), start + 40)];
  });

describe('no product text, doc or hint tells the person to type /models', () => {
  it('names /model and its Model settings row, or the momonga models command line, instead', () => {
    const found = productFiles().flatMap((file) => mentionsOf(fs.readFileSync(file, 'utf8')).map((mention) => `${path.relative(root, file)}: ${mention}`));
    expect(found).toEqual([]);
  });
});
