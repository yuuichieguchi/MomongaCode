import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', 'dist', 'src', '.git', '.claude']);

const testSourcesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : testSourcesUnder(target);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [target] : [];
  });

const testSources = (): string[] => ['packages', 'test', 'e2e', 'scripts'].flatMap((name) => testSourcesUnder(path.join(ROOT, name)));

const closingParenthesis = (text: string, open: number): number => {
  let depth = 0;
  let quote = '';
  for (let index = open; index < text.length; index += 1) {
    const character = text[index] as string;
    if (quote !== '') {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const OBSERVED_DIRECTLY = /(?:\bawait|\breturn|\bvoid|=>)\s*$/;
const BOUND = /\b(?:const|let)\s+([\w$]+)\s*=\s*$/;

const escaped = (name: string): string => name.replace(/\$/g, '\\$');

const observedLater = (text: string, from: number, name: string): boolean =>
  new RegExp(`\\b(?:await|return)\\s+${escaped(name)}\\b|Promise\\.all\\(\\[[^\\]]*\\b${escaped(name)}\\b`).test(text.slice(from));

const unobservedSettlementAssertions = (text: string): number[] => {
  const lines: number[] = [];
  const settlement = /\bexpect(?:\.soft)?\(/g;
  for (;;) {
    const match = settlement.exec(text);
    if (match === null) return lines;
    const close = closingParenthesis(text, match.index + match[0].length - 1);
    if (close === -1) continue;
    if (!/^\s*\.(?:resolves|rejects)\b/.test(text.slice(close + 1, close + 40))) continue;
    const before = text.slice(Math.max(0, match.index - 200), match.index);
    if (OBSERVED_DIRECTLY.test(before)) continue;
    const bound = BOUND.exec(before);
    if (bound !== null && observedLater(text, close, bound[1] as string)) continue;
    lines.push(text.slice(0, match.index).split('\n').length);
  }
};

describe('an assertion on the settlement of a promise is observed', () => {
  it('finds the assertion that nobody awaits, and passes the awaited, returned and bound-then-awaited forms', () => {
    expect(unobservedSettlementAssertions("it('x', () => {\n  expect(run()).rejects.toThrow('no');\n});\n")).toEqual([2]);
    expect(unobservedSettlementAssertions("it('x', () => {\n  expect(run(a, (b))).resolves\n    .toBe(1);\n});\n")).toEqual([2]);
    expect(unobservedSettlementAssertions("it('x', async () => {\n  const later = expect(run()).rejects.toThrow();\n  stop();\n});\n")).toEqual([2]);
    expect(unobservedSettlementAssertions("it('x', async () => {\n  await expect(run()).rejects.toThrow();\n});\n")).toEqual([]);
    expect(unobservedSettlementAssertions("it('x', () => expect(run()).resolves.toBe(1));\n")).toEqual([]);
    expect(unobservedSettlementAssertions("it('x', () => {\n  return expect(run()).resolves.toBe(1);\n});\n")).toEqual([]);
    expect(unobservedSettlementAssertions("it('x', async () => {\n  const later = expect(run()).rejects.toThrow();\n  stop();\n  await later;\n});\n")).toEqual([]);
    expect(unobservedSettlementAssertions("it('x', async () => {\n  expect(await run()).toBe(1);\n});\n")).toEqual([]);
  });

  it('holds in every test file of the repository', () => {
    const own = path.join(ROOT, 'test', 'settlement-assertions-awaited.test.ts');
    const offenders = testSources()
      .filter((file) => file !== own)
      .flatMap((file) => unobservedSettlementAssertions(fs.readFileSync(file, 'utf8')).map((line) => `${path.relative(ROOT, file)}:${line}`));
    expect(offenders).toEqual([]);
  });
});
