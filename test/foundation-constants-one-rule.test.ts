import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as foundation from '@momonga/foundation';
import { hasRow } from './support/host-bounds-scan.ts';
import { parsedProductSource, productSources, relativeOf } from './support/source-scan.ts';

const CONSTANTS_DOCUMENT_VARIABLE = 'MOMONGA_CONSTANTS_DOCUMENT';
const FOUNDATION_ROWS = 'foundation-supervisor-packaging.md';

const NAMED_WITHOUT_A_UNIT = [
  'FILE_CANDIDATE_LIMIT',
  'MAX_CACHED_VALIDATORS',
  'MAX_RECORDED_FAILURES',
  'MAX_SCHEMA_PROBLEMS',
  'READINESS_EXCERPT_CHARACTERS',
  'REAP_KILL_GRACE_MS',
  'SOURCE_READ_WIDTH',
  'STDIO_FLUSH_MS',
];

describe('a foundation constant is one rule with one name', () => {
  it('imports the sweep interval from its one module in every product file that uses it', () => {
    const importers = productSources()
      .flatMap((file) => {
        const binding = parsedProductSource(file).imports.get('SWEEP_INTERVAL_MS');
        return binding === undefined ? [] : [`${relativeOf(file)} from ${binding.module}`];
      });
    expect(importers).toEqual([
      'packages/gateway/src/process.ts from @momonga/foundation',
      'packages/runtime/src/memory/reflection-bound.ts from ../service/service.ts',
      'packages/runtime/src/process/start-runtime-process.ts from @momonga/foundation',
      'packages/runtime/src/service/service.ts from @momonga/foundation',
    ]);
  });

  it('has one stdio flush bound for the exiting daemon and the child the supervisor waits for', () => {
    expect(Object.keys(foundation)).not.toContain('STDIO_EXIT_FLUSH_MS');
    expect(Object.keys(foundation)).not.toContain('CHILD_STDIO_FLUSH_MS');
    expect(foundation.killedChildSettleMs()).toBe(foundation.KILL_CONFIRM_MS + foundation.STDIO_FLUSH_MS);
  });

  it('derives the reap kill grace as two sandbox graces, one for SIGTERM and one for SIGKILL to land', () => {
    expect(foundation.DAEMON_MARKER_KILL_GRACE_MS).toBe(2 * foundation.SANDBOX_KILL_GRACE_MS);
    expect(foundation.ABANDON_KILL_GRACE_MS).toBe(foundation.DAEMON_MARKER_KILL_GRACE_MS);
  });

  const constantsDocument = process.env[CONSTANTS_DOCUMENT_VARIABLE];
  const rowsTitle = `finds the row of every foundation constant whose name carries no unit in the constants document named by ${CONSTANTS_DOCUMENT_VARIABLE}`;
  if (constantsDocument === undefined) {
    it(rowsTitle, (context) => context.skip(`${CONSTANTS_DOCUMENT_VARIABLE} names no document in this run; the release gate sets it`));
  } else {
    it(rowsTitle, () => {
      const document = fs.readFileSync(path.join(constantsDocument, FOUNDATION_ROWS), 'utf8');
      expect(NAMED_WITHOUT_A_UNIT.filter((name) => !hasRow(document, name))).toEqual([]);
    });
  }
});
