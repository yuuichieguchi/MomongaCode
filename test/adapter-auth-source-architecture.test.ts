import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GATEWAY_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/gateway/src');

const filesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

const matching = (directory: string, pattern: RegExp): string[] =>
  filesUnder(directory)
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(GATEWAY_SRC, file));

describe('every adapter authenticates through AuthSource and only the adapter applies a credential effect (O-R5-3 d, e)', () => {
  it('leaves no apiKey option in any adapter source', () => {
    expect(matching(path.join(GATEWAY_SRC, 'adapters'), /\bapiKey\??\s*:/)).toEqual([]);
  });

  it('reads no .credential decision under core/', () => {
    expect(matching(path.join(GATEWAY_SRC, 'core'), /\.credential\b/)).toEqual([]);
    expect(fs.existsSync(path.join(GATEWAY_SRC, 'adapters', 'shared', 'auth.ts'))).toBe(true);
  });
});
