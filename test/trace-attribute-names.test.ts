import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ROOT, lineOf, packageSources, parseSource, parsedProductSource, relativeOf, stringPartsOf } from './support/source-scan.ts';
import type { ParsedSource } from './support/source-scan.ts';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

const SPAN_PACKAGES = ['protocol', 'observability', 'gateway', 'runtime', 'cli'];
const NAMES_FILE = 'packages/protocol/src/trace-attributes.ts';
const ATTRIBUTE_NAME = /(?<![\w$./-])(?:momonga\.[a-z_][\w.]*|error\.type)(?![\w$])/;

const attributeNamesIn = (source: ParsedSource): string[] =>
  stringPartsOf(source)
    .filter(({ text }) => ATTRIBUTE_NAME.test(text))
    .map(({ node, text }) => `${relativeOf(source.file)}:${lineOf(source, node)}: ${text.trim()}`);

const namedIn = (text: string): number => attributeNamesIn(parseSource(path.join(ROOT, 'sample.ts'), text)).length;

describe('span attribute names live in one place (P11)', () => {
  it('protocol/src/trace-attributes.ts exists and holds the names', () => {
    const source = fs.readFileSync(path.join(ROOT, NAMES_FILE), 'utf8');
    expect(source).toMatch(/'momonga\.run_id'/);
    expect(source).toMatch(/'error\.type'/);
  });

  it('finds an attribute name in a string of any quote, in a template part and inside a longer text, and not a constant that holds one', () => {
    expect(namedIn("const name = 'momonga.billing';")).toBe(1);
    expect(namedIn('const name = "momonga.billing";')).toBe(1);
    expect(namedIn("const sql = `SET a = json_set(a, '$.\"momonga.billing\"', ${value})`;")).toBe(1);
    expect(namedIn("const kind = 'error.type';")).toBe(1);
    expect(namedIn("const sql = `json_set(a, '$.\"${MOMONGA_ATTRIBUTES.billing}\"')`;")).toBe(0);
  });

  it('names no attribute in a string outside protocol/src/trace-attributes.ts in the packages that write or read spans', () => {
    const offenders = SPAN_PACKAGES.flatMap(packageSources)
      .filter((file) => relativeOf(file) !== NAMES_FILE)
      .flatMap((file) => attributeNamesIn(parsedProductSource(file)));
    expect(offenders).toEqual([]);
  });

  it('the cli imports the names from protocol instead of retyping them', () => {
    const source = fs.readFileSync(path.join(ROOT, 'packages', 'cli', 'src', 'commands', 'trace.ts'), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\bMOMONGA_ATTRIBUTES\b[^}]*\}\s*from\s*'@momonga\/protocol'/);
    expect(source).toMatch(/import\s*\{[^}]*\bERROR_TYPE_ATTRIBUTE\b[^}]*\}\s*from\s*'@momonga\/protocol'/);
  });
});
