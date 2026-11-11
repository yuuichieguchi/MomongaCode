import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');
const TEST_SUPPORT: readonly string[] = ['dialect-model', path.join('proofs', 'arith.ts'), path.join('proofs', 'prove.ts')];

const sourcesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sourcesUnder(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));

describe('the support of the verification tests', () => {
  it('lives under the test folder of the package and not in the product source', () => {
    expect(TEST_SUPPORT.filter((name) => fs.existsSync(path.join(packageRoot, 'src', name)))).toEqual([]);
    expect(TEST_SUPPORT.filter((name) => !fs.existsSync(path.join(packageRoot, 'test', 'support', name)))).toEqual([]);
  });

  it('is imported by no module of the product source', () => {
    const importers = sourcesUnder(path.join(packageRoot, 'src')).filter((file) => /from '[^']*test\/support\//.test(fs.readFileSync(file, 'utf8')));
    expect(importers).toEqual([]);
  });
});
