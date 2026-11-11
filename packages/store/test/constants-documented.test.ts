import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as memoryConstants from '../src/memory-constants.ts';
import { hasRow } from '../../../test/support/host-bounds-scan.ts';

const CONSTANTS_DOCUMENT_VARIABLE = 'MOMONGA_CONSTANTS_DOCUMENT';

const DOCUMENTED = { 'context.md': Object.keys(memoryConstants) } as const;

const {
  MEMORY_MATCH_BUDGET_MICROS,
  MEMORY_MATCH_LIMIT,
  MEMORY_MATCH_MICROS_PER_ROW,
  MEMORY_SCAN_BUDGET_MICROS,
  MEMORY_SCAN_LIMIT,
  MEMORY_SCAN_MICROS_PER_ROW,
  MEMORY_LIMIT_STEP,
  PAUSE_BUDGET_MICROS,
} = memoryConstants;

describe('the bounds of a memory query are derived from the measured cost of a row', () => {
  it('bounds the indexed match by one third of the pause budget over the cost of a matching note, rounded down to a step', () => {
    expect(MEMORY_MATCH_BUDGET_MICROS).toBe(Math.floor(PAUSE_BUDGET_MICROS / 3));
    expect(MEMORY_MATCH_LIMIT).toBe(Math.floor(MEMORY_MATCH_BUDGET_MICROS / MEMORY_MATCH_MICROS_PER_ROW / MEMORY_LIMIT_STEP) * MEMORY_LIMIT_STEP);
  });

  it('bounds the newest-first scan by the whole pause budget over the cost of a note of the longest text, rounded down to a step', () => {
    expect(MEMORY_SCAN_BUDGET_MICROS).toBe(PAUSE_BUDGET_MICROS);
    expect(MEMORY_SCAN_LIMIT).toBe(Math.floor(MEMORY_SCAN_BUDGET_MICROS / MEMORY_SCAN_MICROS_PER_ROW / MEMORY_LIMIT_STEP) * MEMORY_LIMIT_STEP);
  });

  it('walks the newest notes by their creation index in every scan, so its cost grows with the notes it reads and not with all notes', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'memories.ts'), 'utf8');
    const scans = source.match(/FROM memories(?: INDEXED BY \w+)? WHERE \$\{scope\.sql\}[^`]*ORDER BY created_at DESC, id DESC LIMIT :scanLimit/g) ?? [];
    expect(scans.length).toBe(2);
    expect(scans.every((scan) => scan.includes('INDEXED BY memories_by_created'))).toBe(true);
  });
});

const documentTitle = `writes the derivation of every memory query bound in the constants document named by ${CONSTANTS_DOCUMENT_VARIABLE}`;
const constantsDocument = process.env[CONSTANTS_DOCUMENT_VARIABLE];

describe('the constants of the store carry their derivation', () => {
  if (constantsDocument === undefined) {
    it.skip(documentTitle, () => undefined);
  } else {
    it(documentTitle, () => {
      const missing = Object.entries(DOCUMENTED).flatMap(([file, names]) => names.filter((name) => !hasRow(fs.readFileSync(path.join(constantsDocument, file), 'utf8'), name)));
      expect(missing).toEqual([]);
    });
  }
});
