import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = path.resolve(import.meta.dirname, '../src');

const FORBIDDEN: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: 'node:fs', pattern: /from 'node:fs(\/promises)?'|import\('node:fs|require\('node:fs/ },
  { what: 'node:crypto', pattern: /from 'node:crypto'|import\('node:crypto|require\('node:crypto/ },
  { what: 'Math.random', pattern: /\bMath\.random\b/ },
  { what: 'the host file system', pattern: /\bnodeFileSystem(Sync)?\b/ },
  { what: 'the host random source', pattern: /\bsystemRandom\b/ },
  { what: 'synchronous path resolution', pattern: /\bsyncPaths\b|\banswered(Now)\b/ },
  { what: 'host path resolution', pattern: /\bhostPaths\b/ },
  { what: 'a synchronous file call', pattern: /\b(stat|lstat|open|read|close|mkdir|exists|realpath|readFile|writeFile|readdir|access)Sync\(/ },
];

const sourceFiles = (): string[] =>
  fs
    .readdirSync(SOURCE, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .sort();

describe('the store reaches the file system and randomness only through the ports it is given', () => {
  it('scans the source files of the store', () => {
    expect(sourceFiles()).toContain('blobs.ts');
    expect(sourceFiles()).toContain('trust.ts');
    expect(sourceFiles()).toContain('runtime-store.ts');
  });

  it('holds no direct use of the host file system, of a random source or of synchronous path resolution in any source file', () => {
    const found = sourceFiles().flatMap((name) => {
      const text = fs.readFileSync(path.join(SOURCE, name), 'utf8');
      return FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ what }) => `${name}: ${what}`);
    });
    expect(found).toEqual([]);
  });
});
