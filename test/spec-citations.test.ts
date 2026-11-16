import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const specDir = path.join(repoRoot, 'specs', 'tla');

const CITED_FILE = /[A-Za-z0-9_@./-]*[A-Za-z0-9_-]\.(?:ts|tsx|mts|cts|js|mjs|cjs|json)\b/g;
const SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SYMBOL_LIST = /^ \(([^()]*)\)/;

type Citation = { readonly spec: string; readonly line: number; readonly file: string; readonly after: string };

const headerLinesOf = (text: string): readonly string[] => {
  const lines = text.split('\n');
  const end = lines.findIndex((line) => /^EXTENDS\b/.test(line));
  if (end < 0) throw new Error('the module has no EXTENDS line that closes its header');
  return lines.slice(0, end);
};

const citationsOf = (spec: string): Citation[] =>
  headerLinesOf(fs.readFileSync(path.join(specDir, spec), 'utf8')).flatMap((text, index) =>
    [...text.matchAll(CITED_FILE)].map((match) => ({ spec, line: index + 1, file: match[0], after: text.slice((match.index ?? 0) + match[0].length) })),
  );

const escaped = (word: string): string => word.replace(/[$]/g, '\\$');

const problemsOf = (citation: Citation): string[] => {
  const where = `${citation.spec}:${citation.line} ${citation.file}`;
  if (/^:\d/.test(citation.after)) return [`${where} cites a line number instead of a symbol`];
  const target = path.join(repoRoot, citation.file);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return [`${where} is not a file of the repository (cite it by its path from the repository root)`];
  const list = SYMBOL_LIST.exec(citation.after);
  if (list === null) return [`${where} names no symbol: a citation is "path (symbol, symbol)"`];
  const symbols = (list[1] as string).split(', ');
  const invalid = symbols.filter((symbol) => !SYMBOL.test(symbol));
  if (invalid.length > 0) return [`${where} names no symbol: "(${list[1] as string})" is not a list of names`];
  const source = fs.readFileSync(target, 'utf8');
  return symbols.filter((symbol) => !new RegExp(`(?<![A-Za-z0-9_$])${escaped(symbol)}(?![A-Za-z0-9_$])`).test(source)).map((symbol) => `${where} names ${symbol}, which the file does not contain`);
};

describe('the code citations in the headers of the TLA+ models', () => {
  it('name an existing file of the repository and symbols that file contains, never a line', () => {
    const specs = fs.readdirSync(specDir).filter((file) => file.endsWith('.tla')).sort();
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.flatMap(citationsOf).flatMap(problemsOf)).toEqual([]);
  });
});
