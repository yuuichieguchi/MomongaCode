import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const coreDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core');

const adapterImportsOf = (file: string): string[] =>
  [...fs.readFileSync(file, 'utf8').matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((specifier) => path.resolve(path.dirname(file), specifier).includes(`${path.sep}src${path.sep}adapters${path.sep}`));

describe('gateway core stays independent of adapter code', () => {
  it.for(fs.readdirSync(coreDir).filter((name) => /\.tsx?$/.test(name)))('core/%s imports nothing under src/adapters', (name) => {
    expect(adapterImportsOf(path.join(coreDir, name))).toEqual([]);
  });
});
