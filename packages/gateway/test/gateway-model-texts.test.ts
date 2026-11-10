import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.join(import.meta.dirname, '..', 'src');
const TOKENS = ['the target "', 'target "$', 'model alias', 'alias "'] as const;

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

describe('no sentence of the gateway names a target or an alias (design-model-names 2.10)', () => {
  it('finds none of the old words in any source under packages/gateway/src', () => {
    const hits = sourceFiles(SOURCE_ROOT).flatMap((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return TOKENS.filter((token) => text.includes(token)).map((token) => `${path.relative(SOURCE_ROOT, file)}: ${token}`);
    });
    expect(hits).toEqual([]);
  });
});
