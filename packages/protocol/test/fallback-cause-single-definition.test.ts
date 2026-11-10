import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER = 'protocol/src/fallback-cause.ts';

const sourcesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const productSources = fs
  .readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(packagesDir, entry.name, 'src')))
  .flatMap((entry) => sourcesUnder(path.join(packagesDir, entry.name, 'src')))
  .map((file) => ({ file: path.relative(packagesDir, file).split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') }));

describe('the fallback cause has one definition, in protocol', () => {
  it('the reason billing_change_allowed is written as a literal only in protocol/src/fallback-cause.ts', () => {
    const writers = productSources.filter(({ text }) => /['"`]billing_change_allowed['"`]/.test(text)).map(({ file }) => file);
    expect(writers).toEqual([OWNER]);
  });

  it('the type FallbackCause is declared only in protocol/src/fallback-cause.ts', () => {
    const declarers = productSources.filter(({ text }) => text.includes('type FallbackCause ')).map(({ file }) => file);
    expect(declarers).toEqual([OWNER]);
  });
});
