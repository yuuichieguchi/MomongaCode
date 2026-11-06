import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as context from '@momonga/context';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

const VOCABULARY_NAMES = ['FAILURE_MARKERS', 'isFailureLine', 'failureFactsOf'] as const;

describe('no failure vocabulary decides what a formatter keeps or what its check requires', () => {
  it('@momonga/context does not export FAILURE_MARKERS', () => {
    expect(Object.keys(context)).not.toContain('FAILURE_MARKERS');
  });

  it.each(VOCABULARY_NAMES)('no file under context/src mentions %s', (name) => {
    const mentioning = sourceFiles(SOURCE).filter((file) => readFileSync(file, 'utf8').includes(name));
    expect(mentioning.map((file) => path.relative(SOURCE, file))).toEqual([]);
  });

  it('the log formatter no longer reads the search-document head and tail constants', () => {
    const log = readFileSync(path.join(SOURCE, 'formatters', 'log.ts'), 'utf8');
    expect(log).not.toMatch(/HISTORY_OUTPUT_HEAD_CHARS|HISTORY_OUTPUT_TAIL_CHARS/);
  });
});
