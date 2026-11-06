import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packagesDir = path.resolve(import.meta.dirname, '..', 'packages');

const SPAN_PACKAGES = ['protocol', 'observability', 'gateway', 'runtime', 'cli'];
const NAMES_FILE = 'protocol/src/trace-attributes.ts';
const ATTRIBUTE_LITERAL = /'momonga\.|'error\.type'/;

const sourcesOf = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'dist' ? [] : sourcesOf(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

const relative = (file: string): string => path.relative(packagesDir, file).split(path.sep).join('/');

describe('span attribute names live in one place (P11)', () => {
  it('protocol/src/trace-attributes.ts exists and holds the names', () => {
    const source = fs.readFileSync(path.join(packagesDir, NAMES_FILE), 'utf8');
    expect(source).toMatch(/'momonga\.run_id'/);
    expect(source).toMatch(/'error\.type'/);
  });

  it("no 'momonga. or 'error.type' literal outside protocol/src/trace-attributes.ts in the packages that write or read spans", () => {
    const offenders = SPAN_PACKAGES.flatMap((name) => sourcesOf(path.join(packagesDir, name, 'src')))
      .map(relative)
      .filter((file) => file !== NAMES_FILE)
      .flatMap((file) =>
        fs
          .readFileSync(path.join(packagesDir, file), 'utf8')
          .split('\n')
          .filter((line) => ATTRIBUTE_LITERAL.test(line))
          .map((line) => `${file}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });

  it('the cli imports the names from protocol instead of retyping them', () => {
    const source = fs.readFileSync(path.join(packagesDir, 'cli', 'src', 'commands', 'trace.ts'), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\bMOMONGA_ATTRIBUTES\b[^}]*\}\s*from\s*'@momonga\/protocol'/);
    expect(source).toMatch(/import\s*\{[^}]*\bERROR_TYPE_ATTRIBUTE\b[^}]*\}\s*from\s*'@momonga\/protocol'/);
  });
});
