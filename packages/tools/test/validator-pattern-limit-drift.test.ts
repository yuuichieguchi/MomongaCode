import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATTERN_CHECK_LIMIT_MS } from '@momonga/foundation';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const SCANNED_ROOTS = ['packages/foundation/src', 'packages/tools/src', 'packages/runtime/src', 'packages/ata-validator/lib'];
const LIMIT_NAME = 'PATTERN_CHECK_LIMIT_MS';

const sourceFilesUnder = (relative: string): string[] => {
  const root = path.join(repositoryRoot, relative);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
};

const allSources = SCANNED_ROOTS.flatMap(sourceFilesUnder).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

const checkSources = allSources.filter(({ text }) => text.includes(LIMIT_NAME));

const definitions = allSources.filter(({ text }) => new RegExp(`\\b(const|let|var)\\s+${LIMIT_NAME}\\b`).test(text));

const timerCallsIn = (text: string): string[] => [...text.matchAll(/\b(setTimeout|setInterval|AbortSignal\.timeout)\s*\(([^;]*)/g)].map((match) => match[0]);

const otherTimeNamesIn = (text: string): string[] =>
  [...new Set([...text.matchAll(/\b[A-Z][A-Z0-9_]*_(MS|SECONDS|TIMEOUT)\b/g)].map((match) => match[0]))].filter((name) => name !== LIMIT_NAME);

describe('PATTERN_CHECK_LIMIT_MS is the only limit of the off-thread pattern check', () => {
  it('is 5000 and exported from foundation', () => {
    expect(PATTERN_CHECK_LIMIT_MS).toBe(5000);
  });

  it('is defined once, as 5000', () => {
    expect(definitions.map(({ file }) => path.relative(repositoryRoot, file))).toHaveLength(1);
    expect(definitions[0]!.text).toMatch(new RegExp(`\\b${LIMIT_NAME}\\s*=\\s*5000\\b`));
  });

  it('is read by the module that runs the check in a worker thread', () => {
    expect(checkSources.some(({ text }) => /worker_threads/.test(text))).toBe(true);
  });

  it('leaves the check modules no other time bound', () => {
    expect(checkSources.length).toBeGreaterThan(0);
    for (const { file, text } of checkSources) {
      const relative = path.relative(repositoryRoot, file);
      expect({ file: relative, names: otherTimeNamesIn(text) }).toEqual({ file: relative, names: [] });
      expect({ file: relative, timers: timerCallsIn(text).filter((timer) => !/patternCheckLimitMs|PATTERN_CHECK_LIMIT_MS|limitMs/.test(timer)) }).toEqual({ file: relative, timers: [] });
    }
  });
});
