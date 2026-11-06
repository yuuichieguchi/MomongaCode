import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as tools from '@momonga/tools';

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

const SOURCES = ['tools/src', 'runtime/src', 'context/src'].flatMap((directory) => sourceFiles(path.join(PACKAGES, directory)));

const mentioning = (pattern: RegExp): string[] => SOURCES.filter((file) => pattern.test(readFileSync(file, 'utf8'))).map((file) => path.relative(PACKAGES, file));

describe('one rule decides how much of a tool output the model sees', () => {
  it('inline-limit.ts no longer exists', () => {
    expect(existsSync(path.join(PACKAGES, 'runtime/src/worker/inline-limit.ts'))).toBe(false);
  });

  it.each(['MAX_INLINE_OUTPUT_CHARS', 'CHARS_PER_ITEM_CAP_TOKEN', 'DEFAULT_MAX_INLINE_OUTPUT_CHARS', 'MINIMUM_INLINE_OUTPUT_CHARS', 'inlineLimitForItemCap', 'inlineOutputLimitFor'])(
    '%s is defined nowhere in tools, runtime or context',
    (name) => {
      expect(mentioning(new RegExp(`\\b${name}\\b`))).toEqual([]);
    },
  );

  it('no character ceiling of 30 000 remains in tools, runtime or context', () => {
    const ceilings = SOURCES.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /\b30_?000\b/.test(line) && /char|inline|output/i.test(line) && !/_MS\b|Ms\b/.test(line))
        .map((line) => `${path.relative(PACKAGES, file)}: ${line.trim()}`),
    );
    expect(ceilings).toEqual([]);
  });

  it('@momonga/tools exports no character floor for inline output', () => {
    expect(Object.keys(tools)).not.toContain('MINIMUM_INLINE_OUTPUT_CHARS');
  });

  it('tool code pages by the output fit port, not by a character budget', () => {
    expect(mentioning(/\boutputBudgetChars\b/)).toEqual([]);
    expect(mentioning(/\boutputFit\b/)).not.toEqual([]);
  });

  it('the completion cut and the render cut call the same fitToTokens', () => {
    const callers = mentioning(/\bfitToTokens\b/);
    expect(callers).toContain('context/src/build-context.ts');
    expect(callers.some((file) => file.startsWith('runtime/src/') || file.startsWith('tools/src/'))).toBe(true);
  });
});
